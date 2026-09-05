import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { analyzeAgentEvents, dshFailureReason, runDshChild } from "../session.js";

test("aborting a DSH child stops the active prompt process", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const child = runDshChild(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    process.env,
    undefined,
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort("Prompt cancelled"), 50);

  const result = await child;
  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, 130);
  assert.ok(Date.now() - startedAt < 2_000);
});

test("aborting a DSH child also stops its subprocesses", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "mosaik-child-process-"));
  const pidFile = join(directory, "nested.pid");
  const controller = new AbortController();
  const child = runDshChild(
    process.execPath,
    [
      "-e",
      `const {spawn}=require("node:child_process");
       const {writeFileSync}=require("node:fs");
       const nested=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
       writeFileSync(${JSON.stringify(pidFile)},String(nested.pid));
       setInterval(()=>{},1000);`,
    ],
    process.env,
    undefined,
    { signal: controller.signal },
  );
  try {
    const nestedPid = await waitForPid(pidFile);
    controller.abort("Prompt cancelled");
    const result = await child;
    assert.equal(result.aborted, true);
    await waitForProcessExit(nestedPid);
  } finally {
    controller.abort("Test cleanup");
    await child.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isInteger(pid)) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Nested child did not report its PID");
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Nested child ${pid} was still running after abort`);
}

test("streaming DSH events emits each event once across nested session files", async () => {
  const eventRoot = await mkdtemp(join(tmpdir(), "mosaik-dsh-events-"));
  const received: string[] = [];
  try {
    const result = await runDshChild(
      process.execPath,
      [
        "-e",
        `const {appendFileSync,mkdirSync,writeFileSync}=require("node:fs");
         const {join}=require("node:path");
         const root=process.env.MOSAIK_TEST_EVENT_ROOT;
         const outer=join(root,"outer.jsonl");
         const nestedDir=join(root,"discovery");
         const nested=join(nestedDir,"nested.jsonl");
         const event=(id,time)=>JSON.stringify({type:"test/event",time,data:{id}})+"\\n";
         writeFileSync(outer,event("outer-1",1));
         setTimeout(()=>{mkdirSync(nestedDir);writeFileSync(nested,event("nested-1",2));},220);
         setTimeout(()=>appendFileSync(outer,event("outer-2",3)),440);
         setTimeout(()=>appendFileSync(nested,event("nested-2",4)),660);
         setTimeout(()=>process.exit(0),900);`,
      ],
      { ...process.env, MOSAIK_TEST_EVENT_ROOT: eventRoot },
      undefined,
      {
        eventRoot,
        onEvent: (event) => {
          if (typeof event.data?.id === "string") received.push(event.data.id);
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.deepEqual(received, ["outer-1", "nested-1", "outer-2", "nested-2"]);
  } finally {
    await rm(eventRoot, { recursive: true, force: true });
  }
});

test("nested discovery errors cannot replace the parent task's terminal failure", () => {
  const parentError = "Error: Discovery prerequisite openItem failed: unsupported-state";
  const nestedError = "Error: Conditions need 1 to 32 children";
  const analyzed = analyzeAgentEvents(
    [
      { type: "tool/result", time: 30, data: { value: parentError } },
      { type: "tool/result", time: 10, nestedDiscovery: true, data: { value: nestedError } },
      {
        type: "tool/result",
        time: 20,
        nestedDiscovery: true,
        data: { value: { status: "discovered" } },
      },
    ],
    100,
  );
  assert.deepEqual(analyzed.terminalValues, [parentError]);
  assert.equal(
    dshFailureReason({ stdout: "", stderr: "", exitCode: 1 }, analyzed.terminalValues, "fallback"),
    parentError,
  );
});

test("a discovery task retains its own terminal result when analyzed directly", () => {
  const result = { status: "discovered", action: { name: "openItem" } };
  const analyzed = analyzeAgentEvents([{ type: "tool/result", data: { value: result } }], 100);
  assert.deepEqual(analyzed.terminalValues, [result]);
});

test("loader errors report the actual prerequisite failure", () => {
  const error =
    "Error: file:///loader.js:1187\nError: dsh: plugin tree failed to load: Discovery prerequisite collectLinks failed: Row 31 field href matched 0 elements\nHostActionError: Row 31 field href matched 0 elements";
  assert.equal(
    dshFailureReason({ stdout: "", stderr: "", exitCode: 1 }, [error], "fallback"),
    "Discovery prerequisite collectLinks failed: Row 31 field href matched 0 elements",
  );
});

test("planning navigation contributes browser timing without counting as a automation interaction", () => {
  const analyzed = analyzeAgentEvents(
    [
      { type: "request/header", time: 1000, data: {} },
      {
        type: "tool/code-dispatch",
        time: 1500,
        data: {
          name: "inspectNavigation",
          value: { purpose: "discovery-observation", firstBrowserActionAt: 1200 },
        },
      },
    ],
    500,
  );
  assert.equal(analyzed.metrics.firstBrowserActionMs, 200);
  assert.equal(analyzed.metrics.firstBrowserActionKind, "planning-navigation");
  assert.equal(analyzed.metrics.firstActionMs, undefined);
  assert.equal(analyzed.metrics.nestedToolCalls, 1);
});

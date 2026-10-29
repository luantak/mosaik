import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import { parseExecuteCliArgs, parseJobsCliArgs, parseResumeCliArgs } from "../../cli-options.js";
import { openFileRepository } from "../../persist/repository.js";
import {
  prepareSavedAutomation,
  prepareSavedResume,
  savedExecutionExitCode,
  savedJobResumeCommand,
} from "../../saved-execution.js";
import { prepareJobMetadata } from "../prepare.js";
import { DurableJob, inspectJob } from "../store.js";
import type { TaskAssessment } from "../../automations/acceptance.js";
import type { ItemWork, PageWork } from "../types.js";

const execute = promisify(execFile);
const main = (args: string[], cwd: string) =>
  execute(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("../../cli.ts", import.meta.url)),
      ...args,
    ],
    { cwd, timeout: 20_000 },
  );

const source = `import { defineAutomation } from "mosaik/automations";
export default defineAutomation(import.meta.url, async (ctx, input: { category: string }) => {
  return { category: input.category };
});`;

async function fixture(root: string) {
  const store = openFileRepository({ dataRoot: join(root, ".mosaik"), libraryRoot: root });
  await store.saveAutomation({
    id: "catalogue",
    siteId: "fixture.test",
    version: 1,
    source,
    startUrl: "https://fixture.test/catalogue",
  });
  const prepared = await prepareSavedAutomation(store, {
    siteId: "fixture.test",
    automationId: "catalogue",
    inputs: { category: "books" },
  });
  const metadata = await prepareJobMetadata(prepared.automation, [], {
    input: prepared.input,
    startUrl: prepared.startUrl,
    libraryRoot: root,
    loadAutomationSource: async (id) => prepared.sources.get(id),
  });
  const directory = join(root, "job");
  const job = DurableJob.open(directory, metadata);
  job.configure({
    key: "records",
    initialCursor: "page-1",
    acceptance: {
      requiredFields: ["title"],
      idField: "id",
      sourceUrlField: "url",
      requestedCount: 2,
    },
  });
  job.page(job.next() as PageWork, {
    items: [
      { id: "a", input: { url: "https://fixture.test/a" } },
      { id: "b", input: { url: "https://fixture.test/b" } },
    ],
    nextCursor: null,
    exhausted: true,
  });
  const work = job.next() as ItemWork;
  job.commit(work, { id: work.id, title: "A", url: "https://fixture.test/a" }, work.id);
  return { store, prepared, job, directory };
}

test("resume takes immutable job inputs and preserves browser and invocation limits", () => {
  const parsed = parseResumeCliArgs(
    [
      "jobs/run-1",
      "--headless",
      "--browser",
      "local",
      "--timeout",
      "9000",
      "--max-action-calls",
      "200",
      "--data-dir",
      "state",
      "--json",
    ],
    "/project",
  );
  assert.equal(parsed.help, false);
  if (parsed.help) return;
  assert.equal(parsed.options.jobDirectory, "/project/jobs/run-1");
  assert.equal(parsed.options.dataDirectory, "/project/state");
  assert.equal(parsed.options.timeoutMs, 9000);
  assert.equal(parsed.options.maxActionCalls, 200);
  assert.equal(parsed.options.headless, true);
  assert.equal(parsed.options.browser, "local");
  for (const flag of ["--input", "--input-json", "--url", "--site", "--model", "--job-dir"])
    assert.throws(() => parseResumeCliArgs(["job", flag, "replacement"]), /Unknown option/);
  assert.throws(() => parseResumeCliArgs(["job", "extra"]), /one durable job directory/);
  const selected = parseExecuteCliArgs(
    ["catalogue", "--site", "fixture.test", "--job-dir", "run-1"],
    "/project",
  );
  assert.equal(selected.help, false);
  if (!selected.help) assert.equal(selected.options.jobDirectory, "/project/run-1");
  assert.deepEqual(parseJobsCliArgs(["export", "job", "--json"], "/project"), {
    help: false,
    options: { operation: "export", jobDirectory: "/project/job", json: true },
  });
});

test("CLI exit codes express task completion independently from execution success", () => {
  const base: TaskAssessment = {
    status: "complete",
    collected: 1,
    failedItems: 0,
    terminationReason: "requested-count",
    errors: [],
    outputPaths: [],
    verification: "deterministic",
  };
  for (const [status, code] of [
    ["complete", 0],
    ["incomplete", 2],
    ["failed", 1],
    ["interrupted", 130],
  ] as const)
    assert.equal(savedExecutionExitCode({ ...base, status }), code);
  assert.equal(
    savedExecutionExitCode({ ...base, status: "incomplete", verification: "unverified" }),
    2,
  );
  assert.equal(
    savedJobResumeCommand("/path/reader's run", { headless: true, timeoutMs: 5000 }),
    "mosaik resume '/path/reader'\\''s run' --headless --timeout 5000",
  );
});

test("resume preflight rejects live jobs and source/runtime changes without browser work", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-resume-cli-"));
  let opened: DurableJob | undefined;
  try {
    const { store, prepared, job, directory } = await fixture(root);
    opened = job;
    await assert.rejects(prepareSavedResume(store, directory), /locked by a running process/);
    job.close();
    opened = undefined;
    const resumed = await prepareSavedResume(store, directory);
    assert.deepEqual(resumed.input, { category: "books" });
    assert.equal(resumed.startUrl, "https://fixture.test/catalogue");
    await writeFile(
      prepared.sourcePath,
      prepared.automation.source + "\n// unrelated source edit\n",
    );
    await assert.rejects(
      prepareSavedResume(store, directory),
      /incompatible with the saved automation/,
    );
    await writeFile(prepared.sourcePath, prepared.automation.source);
    const inspection = inspectJob(directory);
    const other = DurableJob.open(join(root, "old-runtime"), {
      ...inspection.metadata,
      runtimeFingerprint: "older-runtime",
    });
    other.close();
    await assert.rejects(
      prepareSavedResume(store, join(root, "old-runtime")),
      /runtime fingerprint/,
    );
  } finally {
    opened?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real CLI inspect and export expose committed partial records without replay or source requirements", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-job-cli-"));
  try {
    const { job, directory, prepared } = await fixture(root);
    job.close();
    const before = inspectJob(directory);
    const inspected = JSON.parse(
      (await main(["jobs", "inspect", directory, "--json"], root)).stdout,
    );
    assert.equal(inspected.summary.status, "interrupted");
    assert.equal(inspected.summary.collected, 1);
    assert.equal(inspected.summary.pending, 1);
    await rm(prepared.sourcePath);
    const exported = JSON.parse((await main(["jobs", "export", directory, "--json"], root)).stdout);
    assert.equal(exported.summary.collected, 1);
    assert.equal(exported.summary.attempts, before.summary.attempts);
    assert.equal(exported.summary.pending, 1);
    assert.equal(exported.summary.status, "interrupted");
    const records = (await readFile(exported.summary.outputPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(records, [{ id: "a", title: "A", url: "https://fixture.test/a" }]);
    assert.equal(await readFile(exported.summary.failuresPath, "utf8"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

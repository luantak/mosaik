import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { chromium } from "playwright";
import { createMosaik, MosaikExecutionError } from "../mosaik.js";
import { defineAutomation } from "../library/automations-api.js";
import { typecheckAutomation } from "../automations/typecheck.js";

const automation = `import { defineAutomation } from "mosaik/automations";
import { readHeading } from "../actions/readHeading.js";
export const readPage = defineAutomation(import.meta.url, async (ctx, input: { prefix: string }) => {
  const result = await readHeading(ctx, {});
  return { title: input.prefix + result.title };
});`;

test("direct import executes in the worker, infers types, reloads dependencies, and keeps supplied sessions open", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-import-"));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let closes = 0;
  const mosaik = await createMosaik({
    session: {
      kind: "ephemeral",
      withPage: async (run) => run(page),
      close: async () => {
        closes++;
      },
    },
  });
  try {
    await page.setContent("<h1>Hello</h1><h2>Updated</h2>");
    const automations = join(root, "sites/example.com/automations");
    const actions = join(root, "sites/example.com/actions");
    const pkg = join(root, "node_modules/mosaik");
    await Promise.all([
      mkdir(automations, { recursive: true }),
      mkdir(actions, { recursive: true }),
      mkdir(pkg, { recursive: true }),
    ]);
    await symlink(resolve("src"), join(pkg, "src"), "dir");
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        type: "module",
        exports: {
          "./automations": "./src/library/automations-api.ts",
          "./actions": "./src/library/actions-api.ts",
        },
      }),
    );
    const action = (
      level: number,
    ) => `import { defineAction, string, extractText, css } from "mosaik/actions";
export const readHeading = defineAction({ id: "read-heading", siteId: "example.com", name: "readHeading", description: "Read the heading", inputs: {}, outputs: { title: string() }, safety: "read-only", steps: [extractText({ id: "heading", locator: css("h${level}"), output: "title", safety: "read-only" })] });`;
    await writeFile(join(actions, "readHeading.ts"), action(1));
    await writeFile(join(automations, "readPage.ts"), automation);
    const imported = await import(pathToFileURL(join(automations, "readPage.ts")).href);
    assert.deepEqual(await imported.readPage(mosaik, { prefix: "Found: " }), {
      title: "Found: Hello",
    });
    await writeFile(join(actions, "readHeading.ts"), action(2));
    assert.deepEqual(await imported.readPage(mosaik, { prefix: "" }), { title: "Updated" });
    const parent = `import { defineAutomation } from "mosaik/automations";
import { readPage } from "./readPage.js";
export default defineAutomation(import.meta.url, async (ctx, input: { prefix: string }) => {
return await readPage(ctx, input);
});`;
    await writeFile(join(automations, "parent.ts"), parent);
    const nested = await import(pathToFileURL(join(automations, "parent.ts")).href);
    assert.deepEqual(await nested.default(mosaik, { prefix: "Nested: " }), {
      title: "Nested: Updated",
    });
    await writeFile(
      join(automations, "readPage.ts"),
      automation.replace(
        "return { title: input.prefix + result.title };",
        'throw new Error("inside worker");',
      ),
    );
    await assert.rejects(imported.readPage(mosaik, { prefix: "" }), MosaikExecutionError);
    await mosaik.close();
    assert.equal(closes, 0);
    await assert.rejects(imported.readPage(mosaik, {}), /closed/);
  } finally {
    await mosaik.close();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("createMosaik humanizes a caller-owned session without changing saved action source", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-humanize-"));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const session: import("../runtime/session.js").BrowserSession = {
    kind: "ephemeral",
    withPage: async (run) => run(page),
    close: async () => {},
  };
  const regular = await createMosaik({ session, humanize: false });
  await page.mouse.move(10, 10);
  await regular.close();
  const mosaik = await createMosaik({ session, humanize: true });
  try {
    await page.setContent(`
      <button style="position:absolute;left:700px;top:420px">Continue</button>
      <script>
        window.moves = [];
        window.clicked = false;
        document.addEventListener("mousemove", event => window.moves.push({ x: event.clientX, y: event.clientY }));
        document.querySelector("button").addEventListener("click", () => window.clicked = true);
      </script>
    `);
    const automations = join(root, "sites/example.com/automations");
    const actions = join(root, "sites/example.com/actions");
    const pkg = join(root, "node_modules/mosaik");
    await Promise.all([
      mkdir(automations, { recursive: true }),
      mkdir(actions, { recursive: true }),
      mkdir(pkg, { recursive: true }),
    ]);
    await symlink(resolve("src"), join(pkg, "src"), "dir");
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        type: "module",
        exports: {
          "./automations": "./src/library/automations-api.ts",
          "./actions": "./src/library/actions-api.ts",
        },
      }),
    );
    const actionSource = `import { defineAction, click, role } from "mosaik/actions";
export const continueTask = defineAction({ id: "continue-task", siteId: "example.com", name: "continueTask", description: "Continue", inputs: {}, outputs: {}, safety: "browser-local", steps: [click({ id: "continue", locator: role("button", "Continue"), safety: "browser-local" })] });`;
    await writeFile(join(actions, "continueTask.ts"), actionSource);
    await writeFile(
      join(automations, "continueTask.ts"),
      `import { defineAutomation } from "mosaik/automations";
import { continueTask } from "../actions/continueTask.js";
export default defineAutomation(import.meta.url, async ctx => { await continueTask(ctx, {}); return "clicked"; });`,
    );
    const imported = await import(pathToFileURL(join(automations, "continueTask.ts")).href);

    assert.equal(await imported.default(mosaik, {}), "clicked");
    const observed = await page.evaluate(() => ({
      moves: (window as unknown as { moves: Array<{ x: number; y: number }> }).moves,
      clicked: (window as unknown as { clicked: boolean }).clicked,
    }));
    assert.equal(observed.clicked, true);
    assert.ok(observed.moves.length > 3);
    assert.ok(Math.hypot(observed.moves[0]!.x - 10, observed.moves[0]!.y - 10) < 2);
    assert.equal(await readFile(join(actions, "continueTask.ts"), "utf8"), actionSource);
  } finally {
    await mosaik.close();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("wrapper dispatches without invoking its body and preserves inferred return types", async () => {
  let bodyCalled = false;
  const typed = defineAutomation(import.meta.url, async (_ctx, input: { query: string }) => {
    bodyCalled = true;
    return { title: input.query };
  });
  const value: { title: string } = await typed(
    { execute: async () => ({ title: "worker" }), close: async () => {} },
    { query: "hello" },
  );
  assert.equal(value.title, "worker");
  assert.equal(bodyCalled, false);
  const invalidCall = () => {
    // @ts-expect-error input must match the generated function
    return typed({} as import("../mosaik.js").Mosaik, { query: 42 });
  };
  void invalidCall;
});

test("composition typechecking accepts explicit context calls and checks action inputs", async () => {
  const contracts = [
    { name: "readHeading", inputs: {}, outputs: { title: { type: "string" as const } } },
  ];
  await typecheckAutomation(automation, contracts, { prefix: "" });
  await assert.rejects(
    typecheckAutomation(
      automation.replace("readHeading(ctx, {})", "readHeading(ctx, { bad: true })"),
      [{ ...contracts[0]!, inputs: { required: { type: "string" as const } } }],
      { prefix: "" },
    ),
    /contracts/,
  );
});

test("imported automations opt into live repair, retain repairs, and reload edited sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-import-repair-"));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const session: import("../runtime/session.js").BrowserSession = {
    kind: "ephemeral",
    defaultStepTimeoutMs: 100,
    withPage: async (run) => run(page),
    close: async () => {},
  };
  const instances: Awaited<ReturnType<typeof createMosaik>>[] = [];
  let repairs = 0;
  const agent: import("../agents/types.js").RepairAgent = {
    async generateRepair() {
      throw new Error("Expected live repair on the existing page");
    },
    async generateLiveRepair(request, livePage) {
      repairs++;
      assert.equal(livePage, page);
      assert.equal(request.failure.stepId, "heading");
      return {
        success: true,
        validated: false,
        patches: [
          {
            type: "replace-locator",
            stepId: "heading",
            locator: { strategy: "css", selector: "h2" },
          },
        ],
        modelResponse: "",
        metrics: {
          modelRequests: 1,
          codeExecutions: 0,
          nestedToolCalls: 0,
          durationMs: 1,
          repairSucceeded: false,
        },
        trajectory: [],
      };
    },
  };
  try {
    const automations = join(root, "sites/example.com/automations");
    const actions = join(root, "sites/example.com/actions");
    await mkdir(automations, { recursive: true });
    await mkdir(actions, { recursive: true });
    const actionPath = join(actions, "readHeading.ts");
    const actionSource = (
      selector: string,
      safety = "read-only",
    ) => `import { defineAction, string, extractText, css } from "mosaik/actions";
export const readHeading = defineAction({ id: "repair-heading", siteId: "example.com", name: "readHeading", description: "Read the heading", inputs: {}, outputs: { title: string() }, safety: "${safety}", steps: [extractText({ id: "heading", locator: css("${selector}"), output: "title", safety: "${safety}" })] });`;
    await writeFile(actionPath, actionSource("h1"));
    const automationPath = join(automations, "readPage.ts");
    await writeFile(automationPath, automation);
    const moduleUrl = pathToFileURL(automationPath).href;
    await page.setContent("<h2>Repaired</h2><h3>Edited</h3>");
    for (const options of [{ session }, { session, repair: false as const }]) {
      const mosaik = await createMosaik(options);
      instances.push(mosaik);
      await assert.rejects(mosaik.execute(moduleUrl, { prefix: "" }), MosaikExecutionError);
    }
    assert.equal(repairs, 0);
    const mosaik = await createMosaik({ session, repair: { agent } });
    instances.push(mosaik);
    assert.deepEqual(await mosaik.execute(moduleUrl, { prefix: "" }), { title: "Repaired" });
    assert.deepEqual(await mosaik.execute(moduleUrl, { prefix: "Again: " }), {
      title: "Again: Repaired",
    });
    assert.equal(repairs, 1);
    assert.equal(await readFile(actionPath, "utf8"), actionSource("h1"));
    await writeFile(actionPath, actionSource("h3"));
    assert.deepEqual(await mosaik.execute(moduleUrl, { prefix: "" }), { title: "Edited" });
    assert.equal(repairs, 1);
    // Opting into repair does not bypass the policy for consequential actions.
    await writeFile(actionPath, actionSource("h1", "external-side-effect"));
    await assert.rejects(mosaik.execute(moduleUrl, { prefix: "" }), (error: unknown) => {
      assert.ok(error instanceof MosaikExecutionError);
      assert.equal(error.result.requiresApproval, true);
      return true;
    });
    assert.equal(repairs, 1);
  } finally {
    await Promise.all(instances.map((instance) => instance.close()));
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

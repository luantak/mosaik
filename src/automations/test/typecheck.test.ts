import assert from "node:assert/strict";
import { test } from "vitest";
import { typecheckAutomation } from "../typecheck.js";
import { createCompositionSession } from "../../capabilities/code-mode.js";
import { createMemoryRegistry } from "../../capabilities/lookup.js";
import { defineAction } from "../../capabilities/define.js";
import { object, string } from "../../capabilities/schema.js";
import { inputRef, navigate } from "../../core/index.js";

const action = defineAction({
  id: "open-record",
  siteId: "records.example",
  name: "openRecord",
  description: "Open the selected record",
  inputs: { item: object({ href: string() }) },
  safety: "browser-local",
  steps: [navigate({ id: "open", url: inputRef("item.href"), safety: "browser-local" })],
});

function source(call: string): string {
  return `import { openRecord } from "../actions/openRecord.js";
import { defineAutomation } from "mosaik/automations";
export default defineAutomation(async (ctx) => {
  const items = [{ href: "https://records.example/one" }];
  for (const item of items) { await ${call}; }
});`;
}

test("composition rejects a missing named object input before saving and accepts correction", async () => {
  let saved = 0;
  const session = createCompositionSession({
    registry: createMemoryRegistry([action]),
    discover: async () => {
      throw new Error("Unexpected discovery");
    },
    saveAutomation: async () => {
      saved++;
    },
  });
  await session.list(action.siteId);
  await assert.rejects(
    () =>
      session.saveAutomation({
        id: "open-records",
        version: 1,
        siteId: action.siteId,
        source: source("openRecord(item)"),
      }),
    /Property .*item.* is missing/,
  );
  assert.equal(saved, 0);
  await session.saveAutomation({
    id: "open-records",
    version: 1,
    siteId: action.siteId,
    source: source("openRecord({ item })"),
  });
  assert.equal(saved, 1);
});

test("context action calls are checked against the same contract", async () => {
  await assert.rejects(
    () => typecheckAutomation(source("ctx.actions.openRecord(item)"), [action]),
    /Property .*item.* is missing/,
  );
  await typecheckAutomation(source("ctx.actions.openRecord({ item })"), [action]);
});

test("optional inputs and property names are represented in generated types", async () => {
  await typecheckAutomation(
    `import { configure } from "../actions/configure.js";
export default defineAutomation(async () => { await configure(); await configure({ "view-mode": "grid" }); });`,
    [
      {
        name: "configure",
        inputs: { "view-mode": { type: "string", optional: true } },
        outputs: {},
      },
    ],
  );
});

test("composition rejects invented required inputs before executing browser actions", async () => {
  const session = createCompositionSession({
    registry: createMemoryRegistry([]),
    suppliedInputs: {},
    discover: async () => {
      throw new Error("unexpected discovery");
    },
    saveAutomation: async () => {
      throw new Error("invalid automation must not be saved");
    },
  });
  await session.list("example.com");
  await assert.rejects(
    session.saveAutomation({
      id: "missing-input",
      siteId: "example.com",
      version: 1,
      source:
        "export default defineAutomation<{ target: string }>(async (ctx, input) => ({ task: input.target }));",
    }),
    /missingOrInvalidAutomationInputs/,
  );
});

test("input validation accepts supplied fields and optional defaults", async () => {
  await typecheckAutomation(
    "export default defineAutomation<{ target: string }>(async (ctx, input) => ({ task: input.target }));",
    [],
    { target: "Read the documentation" },
  );
  await typecheckAutomation(
    'export default defineAutomation<{ target?: string }>(async (ctx, input) => ({ task: input.target ?? "Read the documentation" }));',
    [],
    {},
  );
});

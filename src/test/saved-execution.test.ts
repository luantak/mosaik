import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { automationInputSchema, validateAutomationInputs } from "../library/automation-inputs.js";
import { openFileRepository } from "../persist/repository.js";
import { automationSourcePath } from "../library/paths.js";
import {
  inspectSavedAutomation,
  prepareSavedAutomation,
  savedAutomationRerunCommand,
} from "../saved-execution.js";
import { parseAutomationsCliArgs, parseExecuteCliArgs } from "../cli-options.js";
import { defineAction } from "../capabilities/define.js";

const source = `import { defineAutomation } from "mosaik/automations";
export default defineAutomation(import.meta.url, async (ctx, input: { category: string; count?: number }) => {
  return { category: input.category, count: input.count ?? 10 };
});`;

test("saved execution CLI shares typed input and browser options and validates its limits", () => {
  const parsed = parseExecuteCliArgs(
    [
      "catalogue",
      "--site",
      "shop.test",
      "--input",
      "category=books",
      "--input",
      "count=25",
      "--browser",
      "camoufox",
      "--headless",
      "--timeout",
      "5000",
      "--max-action-calls",
      "12",
      "--output-dir",
      "records",
    ],
    "/project",
  );
  assert.equal(parsed.help, false);
  if (parsed.help) return;
  assert.equal(parsed.options.automationId, "catalogue");
  assert.deepEqual(parsed.options.inputs, { category: "books", count: 25 });
  assert.equal(parsed.options.startUrl, undefined);
  assert.equal(parsed.options.browser, "camoufox");
  assert.equal(parsed.options.timeoutMs, 5000);
  assert.equal(parsed.options.maxActionCalls, 12);
  assert.equal(parsed.options.outputDirectory, "/project/records");
  assert.throws(() => parseExecuteCliArgs(["catalogue"]), /--site/);
  assert.throws(
    () => parseExecuteCliArgs(["catalogue", "--site", "shop", "--timeout", "NaN"]),
    /positive integer/,
  );
  assert.throws(
    () => parseExecuteCliArgs(["catalogue", "--site", "shop", "--max-action-calls", "0"]),
    /positive integer/,
  );
  assert.throws(
    () => parseExecuteCliArgs(["catalogue", "--site", "shop", "--model", "model"]),
    /Unknown option/,
  );
  assert.deepEqual(
    parseAutomationsCliArgs(["inspect", "catalogue", "--site", "shop", "--json"], "/project"),
    {
      help: false,
      options: {
        operation: "inspect",
        automationId: "catalogue",
        siteId: "shop",
        json: true,
        dataDirectory: "/project/.mosaik",
      },
    },
  );
  assert.throws(() => parseAutomationsCliArgs(["inspect", "catalogue"]), /--site/);
});

test("automation parameters are read without evaluating source and reject missing, unknown, and malformed input", () => {
  const schema = automationInputSchema(source);
  assert.deepEqual(schema, {
    category: { type: "string" },
    count: { type: "number", optional: true },
  });
  assert.deepEqual(validateAutomationInputs(schema, { category: "books" }), { category: "books" });
  assert.throws(() => validateAutomationInputs(schema, {}), /category is required/);
  assert.throws(
    () => validateAutomationInputs(schema, { category: "books", count: "25" }),
    /count must be a number/,
  );
  assert.throws(
    () => validateAutomationInputs(schema, { category: "books", typo: true }),
    /not a declared input/,
  );
  const nested = automationInputSchema(
    `type Filter = { enabled: boolean; values: string[] }; export default defineAutomation(async (ctx, input: { filter: Filter }) => input);`,
  );
  assert.deepEqual(
    validateAutomationInputs(nested, { filter: { enabled: true, values: ["books"] } }),
    { filter: { enabled: true, values: ["books"] } },
  );
  assert.throws(
    () => validateAutomationInputs(nested, { filter: { enabled: true, values: [1] } }),
    /must be a string/,
  );
  assert.throws(
    () =>
      automationInputSchema("export default defineAutomation(async (ctx, input: any) => input);"),
    /Unsupported automation input type/,
  );
});

test("saved automation preparation persists its start URL, supports changed inputs and canonical source edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-saved-"));
  try {
    const store = openFileRepository({ dataRoot: join(root, ".mosaik"), libraryRoot: root });
    await store.saveAutomation({
      id: "catalogue",
      siteId: "shop.test",
      version: 1,
      source,
      inputs: automationInputSchema(source),
      startUrl: "https://shop.test/catalogue",
    });
    const first = await prepareSavedAutomation(store, {
      siteId: "shop.test",
      automationId: "catalogue",
      inputs: { category: "books" },
    });
    const next = await prepareSavedAutomation(store, {
      siteId: "shop.test",
      automationId: "catalogue",
      inputs: { category: "games", count: 5 },
    });
    assert.equal(first.startUrl, "https://shop.test/catalogue");
    assert.equal(next.automation.id, first.automation.id);
    assert.deepEqual(next.input, { category: "games", count: 5 });
    assert.equal(next.sources.size, 1);
    await assert.rejects(
      prepareSavedAutomation(store, { siteId: "shop.test", automationId: "catalogue", inputs: {} }),
      /category is required/,
    );
    assert.deepEqual(
      (await inspectSavedAutomation(store, "shop.test", "catalogue")).inputs,
      automationInputSchema(source),
    );
    const path = automationSourcePath(root, "shop.test", "catalogue");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("category: string", "category: number"),
    );
    await assert.rejects(
      prepareSavedAutomation(store, {
        siteId: "shop.test",
        automationId: "catalogue",
        inputs: { category: "books" },
      }),
      /must be a number/,
    );
    await assert.rejects(
      prepareSavedAutomation(store, { siteId: "shop.test", automationId: "../escape", inputs: {} }),
      /Automation ID/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source-only libraries are inspectable and executable with an explicit start URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-saved-source-"));
  try {
    const directory = join(root, "sites", "shop.test", "automations");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "catalogue.ts"), source);
    const store = openFileRepository({ dataRoot: join(root, ".mosaik"), libraryRoot: root });
    assert.deepEqual(await store.listAutomationIds("shop.test"), ["catalogue"]);
    await assert.rejects(
      prepareSavedAutomation(store, {
        siteId: "shop.test",
        automationId: "catalogue",
        inputs: { category: "books" },
      }),
      /supply --url/,
    );
    const prepared = await prepareSavedAutomation(store, {
      siteId: "shop.test",
      automationId: "catalogue",
      inputs: { category: "books" },
      startUrl: "http://localhost:4317",
    });
    assert.equal(prepared.startUrl, "http://localhost:4317/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saved execution refuses external mutation before any browser can open", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-saved-safety-"));
  try {
    const store = openFileRepository({ dataRoot: join(root, ".mosaik"), libraryRoot: root });
    await store.siteActions.save(
      defineAction({
        id: "shop.delete",
        name: "deleteRecord",
        siteId: "shop.test",
        description: "Delete a record",
        inputs: {},
        outputs: {},
        safety: "external-side-effect",
        steps: [
          {
            id: "delete",
            type: "click",
            locator: { strategy: "role", role: "button", name: "Delete" },
            safety: "external-side-effect",
          },
        ],
      }),
    );
    await store.saveAutomation({
      id: "delete",
      siteId: "shop.test",
      version: 1,
      startUrl: "https://shop.test",
      source: "export default defineAutomation(async (ctx) => ctx.actions.deleteRecord({}));",
    });
    await assert.rejects(
      prepareSavedAutomation(store, { siteId: "shop.test", automationId: "delete", inputs: {} }),
      /refuses external side effects/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rerun command quotes caller values without treating them as shell code", () => {
  const command = savedAutomationRerunCommand({
    automationId: "catalogue",
    siteId: "shop.test",
    inputs: { category: "reader's $(secret)" },
  });
  assert.equal(
    command,
    `mosaik execute 'catalogue' --site 'shop.test' --input-json '{"category":"reader'\\''s $(secret)"}'`,
  );
});

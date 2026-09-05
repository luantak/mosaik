import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineAction, string, array, object } from "../../capabilities/index.js";
import { click, extractList, label, role, urlField } from "../actions-api.js";
import { emitActionSource, parseActionSource } from "../action-source.js";
import { parseAutomationImports, referencedImportedActions } from "../automation-imports.js";
import { actionSourcePath, automationImportPath, automationSourcePath } from "../paths.js";
import { resolveAutomationSourceForExecution } from "../resolve-automation.js";
import { openFileRepository } from "../../persist/index.js";
import { executeComposedAutomation } from "../../automations/sandbox.js";
import { createStubHost } from "../../automations/host.js";
import { validateAutomation, referencedActions } from "../../automations/validate.js";

test("action source round-trips through emit and parse", () => {
  const action = defineAction({
    id: "shop.search-products",
    siteId: "shop.example.com",
    name: "searchProducts",
    description: "Search the catalog",
    contexts: ["catalog overview"],
    safety: "read-only",
    inputs: { query: string() },
    outputs: {},
    steps: [
      click({
        id: "submit",
        locator: role("button", { name: "Search" }),
        safety: "read-only",
      }),
    ],
  });
  const source = emitActionSource(action);
  const parsed = parseActionSource(source);
  assert.equal(parsed.id, action.id);
  assert.equal(parsed.name, action.name);
  assert.deepEqual(parsed.contexts, ["catalog overview"]);
  assert.equal(parsed.implementation.steps.length, 1);
  assert.match(source, /import \{\n  defineAction,\n  click,\n  role,\n  string,\n\}/);
  assert.doesNotMatch(source, /\bextractList\b/);
  assert.doesNotMatch(source, /\boptional\b/);
});

test("defineAction values are typed as callable", () => {
  const action = defineAction({
    id: "shop.search-products",
    siteId: "shop.example.com",
    name: "searchProducts",
    description: "Search the catalog",
    safety: "read-only",
    inputs: { query: string() },
    outputs: {},
    steps: [
      click({
        id: "submit",
        locator: label("Search"),
        safety: "read-only",
      }),
    ],
  });
  const call: (args?: { query: string }) => Promise<{ [key: string]: never }> = action;
  assert.equal(typeof call, "object");
});

test("action source preserves absolute URL extraction fields", () => {
  const action = defineAction({
    id: "books.extract-downloads",
    siteId: "books.example.com",
    name: "extractDownloads",
    description: "Extract downloadable file URLs",
    safety: "read-only",
    outputs: { files: array(object({ url: string() })) },
    steps: [
      extractList({
        id: "files",
        locator: role("link"),
        output: "files",
        fields: { url: urlField("href") },
        safety: "read-only",
      }),
    ],
  });

  const source = emitActionSource(action);
  const parsed = parseActionSource(source);
  const step = parsed.implementation.steps[0];
  assert.match(source, /urlField\("href"\)/);
  assert.equal(step?.type === "extract-list" ? step.fields.url?.source : undefined, "url");
});

test("defineAction infers output field types from schema helpers", () => {
  const action = defineAction({
    id: "quotes.extract-quotes",
    siteId: "quotes.toscrape.com",
    name: "extractQuotes",
    description: "Extract quotes",
    safety: "read-only",
    inputs: {},
    outputs: {
      quotes: array(object({ text: string(), author: string() })),
    },
    steps: [
      click({
        id: "noop",
        locator: label("Search"),
        safety: "read-only",
      }),
    ],
  });
  type Quotes = Awaited<ReturnType<typeof action>>["quotes"];
  const quotes: Quotes = [{ text: "hi", author: "a" }];
  assert.equal(quotes[0]?.text, "hi");
});

test("repository writes action and automation TypeScript beside metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-library-"));
  try {
    const store = openFileRepository(root);
    const action = defineAction({
      id: "shop.search-products",
      siteId: "shop.example.com",
      name: "searchProducts",
      description: "Search the catalog",
      safety: "read-only",
      inputs: { query: string() },
      outputs: {},
      steps: [
        click({
          id: "submit",
          locator: label("Search"),
          safety: "read-only",
        }),
      ],
    });
    await store.siteActions.save(action);
    const actionTs = await readFile(actionSourcePath(root, action.siteId, action.name), "utf8");
    assert.match(actionTs, /export const searchProducts = defineAction/);
    assert.match(
      actionTs,
      /^import \{ defineAction, click, label, string \} from "mosaik\/actions";/,
    );
    assert.deepEqual(parseActionSource(actionTs).implementation, action.implementation);

    const automation = {
      id: "search-mugs",
      siteId: "shop.example.com",
      version: 1,
      source: `import { defineAutomation } from "mosaik/automations";
import { searchProducts } from "${automationImportPath(action.siteId, action.name)}";
export default defineAutomation(async(ctx,input)=>{return searchProducts({query:input.query})});
`,
      actionIds: [action.id],
    };
    await store.saveAutomation(automation);
    const automationTs = await readFile(
      automationSourcePath(root, automation.siteId, automation.id),
      "utf8",
    );
    assert.match(automationTs, /import \{ searchProducts \}/);
    assert.match(
      automationTs,
      /async \(ctx, input\) => \{\n  return searchProducts\(\{ query: input.query \}\);\n\}\);\n$/,
    );
    const loaded = await store.getAutomation(automation.siteId, automation.id);
    assert.equal(loaded?.source, automationTs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateAutomation allows library imports and tracks referenced actions", () => {
  const source = `import { defineAutomation } from "mosaik/automations";
import { searchProducts } from "../actions/searchProducts.js";
export default defineAutomation(async (ctx, input) => {
  return searchProducts({ query: input.query });
});
`;
  validateAutomation(source, {
    actionNames: ["searchProducts"],
    libraryRoot: "/tmp/library",
    automationId: "search-mugs",
  });
  assert.deepEqual(referencedActions(source), ["searchProducts"]);
  assert.deepEqual(referencedImportedActions(source), ["searchProducts"]);
  assert.equal(
    parseAutomationImports(source).some((entry) => entry.kind === "action"),
    true,
  );
});

test("sandbox resolves action imports to host invokes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-library-exec-"));
  try {
    const automation = {
      id: "search-mugs",
      siteId: "shop.example.com",
      version: 1,
      source: `import { defineAutomation } from "mosaik/automations";
import { searchProducts } from "../actions/searchProducts.js";
export default defineAutomation(async (ctx, input) => {
  return searchProducts({ query: input.query });
});
`,
    };
    const calls: Array<{ name: string; args: unknown }> = [];
    const result = await executeComposedAutomation(automation, {
      libraryRoot: root,
      actionNames: ["searchProducts"],
      host: createStubHost({
        searchProducts: async (args) => {
          calls.push({ name: "searchProducts", args });
          return { products: [{ title: "Mug" }] };
        },
      }),
      input: { query: "mug" },
    });
    assert.equal(result.success, true);
    assert.deepEqual(calls, [{ name: "searchProducts", args: { query: "mug" } }]);
    assert.deepEqual(result.value, { products: [{ title: "Mug" }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox resolves nested automation imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-library-nested-"));
  try {
    const inner = `import { defineAutomation } from "mosaik/automations";
import { searchProducts } from "../actions/searchProducts.js";
export default defineAutomation(async (ctx, input) => {
  return searchProducts({ query: input.query });
});
`;
    const outer = `import { defineAutomation } from "mosaik/automations";
import searchMugs from "./search-mugs.js";
export default defineAutomation(async (ctx, input) => {
  return searchMugs({ query: input.query });
});
`;
    const resolved = await resolveAutomationSourceForExecution({
      libraryRoot: root,
      automation: {
        id: "outer",
        siteId: "shop.example.com",
        version: 1,
        source: outer,
      },
      loadAutomationSource: async (id) => (id === "search-mugs" ? inner : undefined),
    });
    assert.equal(resolved.actionNames.includes("searchProducts"), true);

    const result = await executeComposedAutomation(
      {
        id: "outer",
        siteId: "shop.example.com",
        version: 1,
        source: outer,
      },
      {
        libraryRoot: root,
        actionNames: ["searchProducts"],
        loadAutomationSource: async (id) => (id === "search-mugs" ? inner : undefined),
        host: createStubHost({
          searchProducts: async () => ({ ok: true }),
        }),
        input: { query: "mug" },
      },
    );
    assert.equal(result.success, true);
    assert.deepEqual(result.value, { ok: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

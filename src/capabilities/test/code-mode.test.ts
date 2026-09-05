import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectSemanticWorkflow, runCompositionCode } from "../../agents/dsh/composition-tools.js";
import {
  click,
  extractList,
  fill,
  hrefField,
  inputRef,
  label,
  navigate,
  role,
  testId,
  textField,
} from "../../core/index.js";
import { openFileRepository } from "../../persist/repository.js";
import type { ComposedAutomation } from "../../automations/types.js";
import {
  array,
  assertMosaikAutomation,
  createCompositionSession,
  createMemoryRegistry,
  defineAction,
  parseTerminalComposition,
  productRef,
  string,
  unwrapCodeModeValue,
} from "../index.js";

const SEARCH_SOURCE = `
export default defineAutomation(async (ctx, input) => {
  return await ctx.actions.searchProducts({ query: input.query });
});
`;

test("refuses to persist Code Mode as an automation", () => {
  assert.throws(
    () =>
      assertMosaikAutomation(`
export default defineAutomation(async (ctx) => {
  await tools.listCapabilities({ siteId: "shop.example.com" });
  return {};
});
`),
    /Code Mode is not a persisted automation/,
  );
  assert.throws(
    () =>
      parseTerminalComposition({
        status: "composed",
        automation: {
          id: "bad",
          siteId: "shop.example.com",
          source: "export default defineAutomation(async () => { return run_code(); });",
        },
      }),
    /Code Mode is not a persisted automation/,
  );
});

test("Code Mode inspects, discovers the missing action, and persists Mosaik TypeScript", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-c24-"));
  try {
    const store = openFileRepository(root);
    const discovered: string[] = [];
    const session = createCompositionSession({
      registry: store.siteActions,
      discover: async (need) => {
        discovered.push(need.intent ?? need.name ?? "");
        return catalogSearch("shop.example.com");
      },
      saveAutomation: (automation) => store.saveAutomation(automation),
    });

    await assert.rejects(
      () =>
        session.compose({
          siteId: "shop.example.com",
          task: "Search for mugs.",
          needs: [{ intent: "search the product catalog" }],
        }),
      /Inspect site capabilities before composing or discovering/,
    );

    const prepared = await runCompositionCode(
      session,
      `
      return await tools.prepareComposition({
        siteId: "shop.example.com",
        task: "Search for mugs.",
        needs: [
          { name: "navigateProvided", intent: "navigate to the provided start URL" },
          { intent: "search the product catalog" },
        ],
      });
    `,
    );
    const preparedPayload = unwrapCodeModeValue(prepared.value) as {
      discovered: Array<{ name: string }>;
      runtimeHandled: Array<{ name: string }>;
    };
    assert.deepEqual(
      preparedPayload.discovered.map((action) => action.name),
      ["searchProducts"],
    );
    assert.deepEqual(
      preparedPayload.runtimeHandled.map((need) => need.name),
      ["navigateProvided"],
    );

    const ran = await runCompositionCode(
      session,
      `
      return await tools.finishComposition({
        siteId: "shop.example.com",
        task: "Search for mugs.",
        needs: [{ intent: "search the product catalog" }],
        automationId: "search-mugs",
        automationSource: ${JSON.stringify(SEARCH_SOURCE)},
      });
    `,
    );

    const terminal = parseTerminalComposition(ran.value);
    assert.equal(terminal.status, "composed");
    assert.equal(terminal.automation.id, "search-mugs");
    assert.match(terminal.automation.source, /defineAutomation/);
    assert.match(terminal.automation.source, /ctx\.actions\.searchProducts/);
    assert.equal(terminal.automation.source.includes("listCapabilities"), false);
    assert.equal(terminal.automation.source.includes("run_code"), false);
    assert.deepEqual(terminal.reused, ["searchProducts"]);
    assert.deepEqual(terminal.discovered, []);
    assert.deepEqual(discovered, ["search the product catalog"]);
    assert.equal(prepared.runCodeExecutions + ran.runCodeExecutions, 2);
    assert.equal(prepared.nestedToolCalls + ran.nestedToolCalls, 2);

    const loaded = await openFileRepository(root).getAutomation("shop.example.com", "search-mugs");
    assert.equal(loaded?.source.trim(), SEARCH_SOURCE.trim());
    assert.match(loaded?.source ?? "", /defineAutomation/);
    assert.equal(loaded?.source.includes("await tools."), false);
    assert.deepEqual(
      (await openFileRepository(root).siteActions.list("shop.example.com")).map(
        (action) => action.name,
      ),
      ["searchProducts"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Code Mode will not compose or discover before inspect", async () => {
  const session = createCompositionSession({
    registry: createMemoryRegistry(),
    discover: async () => catalogSearch("shop.example.com"),
    saveAutomation: async () => undefined,
  });
  await assert.rejects(
    () =>
      runCompositionCode(
        session,
        `
        await tools.composeTask({
          siteId: "shop.example.com",
          task: "Search for mugs.",
          needs: [{ intent: "search the product catalog" }],
        });
      `,
      ),
    /Inspect site capabilities before composing or discovering/,
  );
  await assert.rejects(
    () =>
      session.discover({
        siteId: "shop.example.com",
        intent: "search the product catalog",
      }),
    /Inspect site capabilities before composing or discovering/,
  );
});

test("saveAutomation rejects a Code Mode script even after inspect", async () => {
  const registry = createMemoryRegistry();
  const automations = new Map<string, string>();
  const session = createCompositionSession({
    registry,
    discover: async () => catalogSearch("shop.example.com"),
    saveAutomation: async (automation) => {
      automations.set(automation.id, automation.source);
    },
  });
  await session.list("shop.example.com");
  await assert.rejects(
    () =>
      session.saveAutomation({
        id: "leaked-code-mode",
        siteId: "shop.example.com",
        version: 1,
        source: `
export default defineAutomation(async (ctx) => {
  const listed = await tools.listCapabilities({ siteId: "shop.example.com" });
  return listed;
});
`,
      }),
    /Code Mode is not a persisted automation/,
  );
  assert.equal(automations.size, 0);
});

test("saveAutomation derives dependencies from static action calls", async () => {
  const action = catalogSearch("shop.example.com");
  let saved: ComposedAutomation | undefined;
  const session = createCompositionSession({
    registry: createMemoryRegistry([action]),
    discover: async () => action,
    saveAutomation: async (automation) => {
      saved = automation;
    },
  });
  await session.list("shop.example.com");
  await session.saveAutomation({
    id: "derived-dependencies",
    siteId: "shop.example.com",
    version: 1,
    source: SEARCH_SOURCE,
    actionIds: ["wrong.action"],
    dependencies: [{ actionId: "wrong.action", actionVersion: 99, interfaceVersion: 99 }],
  });
  assert.deepEqual(saved?.actionIds, [action.id]);
  assert.deepEqual(
    saved?.dependencies?.map((dependency) => dependency.actionId),
    [action.id],
  );
});

test("full reuse composes and persists in one Code Mode execution", async () => {
  const action = catalogSearch("shop.example.com");
  let saved: ComposedAutomation | undefined;
  let discoveries = 0;
  const session = createCompositionSession({
    registry: createMemoryRegistry([action]),
    discover: async () => {
      discoveries += 1;
      return action;
    },
    saveAutomation: async (automation) => {
      saved = automation;
    },
  });
  await session.list("shop.example.com");
  const ran = await runCompositionCode(
    session,
    `
      return await tools.finishComposition({
        siteId: "shop.example.com",
        task: "Search for mugs.",
        needs: [{ name: "searchProducts", intent: "search the product catalog" }],
        automationId: "fast-reuse",
        automationSource: ${JSON.stringify(SEARCH_SOURCE)},
      });
    `,
  );
  assert.equal(parseTerminalComposition(ran.value).automation.id, "fast-reuse");
  assert.equal(ran.runCodeExecutions, 1);
  assert.equal(discoveries, 0);
  assert.equal(saved?.source, SEARCH_SOURCE);
});

test("workflow contracts preserve contextual per-item stages during reuse", async () => {
  const actions = [
    workflowAction("extractBooks", "Extract book references from the catalog", "catalog overview"),
    workflowAction("openProduct", "Open one collected book", "catalog overview"),
    workflowAction("extractCover", "Extract a cover from the opened book", "book detail"),
  ];
  const session = createCompositionSession({
    registry: createMemoryRegistry(actions),
    discover: async () => {
      throw new Error("all workflow actions should be reused");
    },
    saveAutomation: async () => undefined,
  });
  await session.list("books.example.com");
  const needs = `[
    { stage: "collect", name: "extractBooks", intent: "collect books", context: "catalog overview", cardinality: "once" },
    { stage: "open", name: "openProduct", intent: "open each book", context: "catalog overview", after: ["collect"], cardinality: "per-item" },
    { stage: "extract", name: "extractCover", intent: "extract its cover", context: "book detail", after: ["open"], cardinality: "per-item" }
  ]`;

  await assert.rejects(
    () =>
      runCompositionCode(
        session,
        `
        return await tools.finishComposition({
          siteId: "books.example.com",
          task: "Collect books, with opening before detail extraction.",
          needs: ${needs},
          automationSource: ${JSON.stringify(`
            export default defineAutomation(async () => {
              await extractBooks();
              await openProduct();
              await extractCover();
            });
          `)},
        });
      `,
      ),
    /stage open must run inside an item loop/,
  );

  const completed = await runCompositionCode(
    session,
    `
      return await tools.finishComposition({
        siteId: "books.example.com",
        task: "Collect books, with opening before detail extraction.",
        needs: ${needs},
        automationId: "detail-covers",
        automationSource: ${JSON.stringify(`
          import { extractBooks } from "../actions/extractBooks.js";
          import { openProduct } from "../actions/openProduct.js";
          import { extractCover } from "../actions/extractCover.js";
          export default defineAutomation(async () => {
            await extractBooks();
            for (const book of [1]) {
              await openProduct({ book });
              await extractCover();
            }
          });
        `)},
      });
    `,
  );
  assert.equal(parseTerminalComposition(completed.value).automation.id, "detail-covers");
});

test("workflow projection keeps semantic URL extraction and reconnects runtime navigation", () => {
  const projected = projectSemanticWorkflow([
    {
      stage: "start",
      name: "openProvidedUrl",
      intent: "open the provided URL",
      cardinality: "once",
    },
    {
      stage: "collect",
      name: "extractResourceUrls",
      intent: "extract resource URLs from the item listing",
      after: ["start"],
      cardinality: "once",
    },
    {
      stage: "open-item",
      name: "openItem",
      intent: "open each item",
      after: ["collect"],
      cardinality: "per-item",
    },
  ]);

  assert.deepEqual(
    projected.runtimeHandled.map((need) => need.stage),
    ["start"],
  );
  assert.deepEqual(
    projected.needs.map((need) => ({ stage: need.stage, after: need.after })),
    [
      { stage: "collect", after: [] },
      { stage: "open-item", after: ["collect"] },
    ],
  );
});

test("workflow projection does not replay an action that only opens the current start URL", () => {
  const startUrl = "http://127.0.0.1:8000/editor?id=115&version=latest";
  const projected = projectSemanticWorkflow(
    [
      {
        stage: "open-editor",
        name: "openProjectEditor",
        intent: `Open the project editor at ${startUrl}`,
        cardinality: "once",
      },
      {
        stage: "add-shape",
        name: "addShape",
        intent: "Add a shape on the current editor page",
        after: ["open-editor"],
        cardinality: "once",
      },
    ],
    startUrl,
  );

  assert.deepEqual(
    projected.runtimeHandled.map((need) => need.stage),
    ["open-editor"],
  );
  assert.deepEqual(projected.needs, [
    {
      stage: "add-shape",
      name: "addShape",
      intent: "Add a shape on the current editor page",
      after: [],
      cardinality: "once",
    },
  ]);
});

test("finishComposition rejects replaying a runtime-handled start URL action", async () => {
  const startUrl = "https://example.com/editor?id=115&version=latest";
  const session = createCompositionSession({
    registry: createMemoryRegistry([
      workflowAction("openProjectEditor", "Open the project editor", "project editor"),
      workflowAction("addShape", "Add a shape", "project editor"),
    ]),
    discover: async () => {
      throw new Error("known actions should be reused");
    },
    saveAutomation: async () => undefined,
  });

  await assert.rejects(
    () =>
      runCompositionCode(
        session,
        `return await tools.finishComposition({
          siteId: "example.com",
          task: "Add a shape in the open editor",
          needs: [
            { stage: "open", name: "openProjectEditor", intent: "Open ${startUrl}", cardinality: "once" },
            { stage: "add", name: "addShape", intent: "Add a shape", after: ["open"], cardinality: "once" }
          ],
          automationSource: 'export default defineAutomation(async () => { await openProjectEditor({}); await addShape({}); });'
        });`,
        { startUrl, compact: true },
      ),
    /already satisfied by startUrl; omit action openProjectEditor/,
  );
});

test("finishComposition cannot weaken a workflow after preparation", async () => {
  const action = workflowAction("extractItems", "Extract item references", "catalog listing");
  const session = createCompositionSession({
    registry: createMemoryRegistry([action]),
    discover: async () => {
      throw new Error("known action should be reused");
    },
    saveAutomation: async () => undefined,
  });

  await assert.rejects(
    () =>
      runCompositionCode(
        session,
        `
          const prepared = [{ stage: "collect", name: "extractItems", intent: "extract items", context: "catalog listing", cardinality: "once" }];
          await tools.prepareComposition({ siteId: "books.example.com", task: "extract items", needs: prepared });
          return await tools.finishComposition({
            siteId: "books.example.com",
            task: "extract items",
            needs: [{ stage: "different", name: "extractItems", intent: "extract items", context: "catalog listing", cardinality: "once" }],
            automationSource: "export default defineAutomation(async () => extractItems({}));"
          });
        `,
      ),
    /must use the exact workflow stages previously prepared/,
  );
});

test("item-page requests cannot collapse into listing extraction", async () => {
  const session = createCompositionSession({
    registry: createMemoryRegistry([]),
    discover: async () => {
      throw new Error("invalid workflow should fail before discovery");
    },
    saveAutomation: async () => undefined,
  });

  await assert.rejects(
    () =>
      runCompositionCode(
        session,
        `
          return await tools.prepareComposition({
            siteId: "shop.example.com",
            task: "Download images from item pages, not the overview",
            needs: [{ stage: "extract", name: "extractCoverUrls", intent: "extract images from the listing", context: "catalog listing", cardinality: "once" }]
          });
        `,
      ),
    /requires item pages: add a per-item open stage and a dependent per-item extraction stage/,
  );
});

test("workflow contracts leave independent stages reorderable", async () => {
  const session = createCompositionSession({
    registry: createMemoryRegistry([
      workflowAction("getPrice", "Read the current product price", "product detail"),
      workflowAction("getDetails", "Read the current product details", "product detail"),
    ]),
    discover: async () => {
      throw new Error("independent stages should be reused");
    },
    saveAutomation: async () => undefined,
  });
  await session.list("books.example.com");
  const completed = await runCompositionCode(
    session,
    `
      return await tools.finishComposition({
        siteId: "books.example.com",
        task: "Read the price and details in either order.",
        needs: [
          { stage: "price", name: "getPrice", intent: "read price", context: "product detail", cardinality: "once" },
          { stage: "details", name: "getDetails", intent: "read details", context: "product detail", cardinality: "once" }
        ],
        automationId: "independent-read",
        automationSource: ${JSON.stringify(`
          import { getDetails } from "../actions/getDetails.js";
          import { getPrice } from "../actions/getPrice.js";
          export default defineAutomation(async () => {
            const details = await getDetails();
            const price = await getPrice();
            return { details, price };
          });
        `)},
      });
    `,
  );
  assert.equal(parseTerminalComposition(completed.value).automation.id, "independent-read");
});

test("finishComposition keeps thresholds in generated TypeScript", async () => {
  const action = catalogSearch("shop.example.com");
  const session = createCompositionSession({
    registry: createMemoryRegistry([action]),
    discover: async () => action,
    saveAutomation: async () => undefined,
  });
  await assert.rejects(
    () =>
      runCompositionCode(
        session,
        `
        return await tools.finishComposition({
          siteId: "shop.example.com",
          task: "Add every mug under 20 euros to the cart.",
          needs: [{ intent: "search the product catalog" }],
          automationSource: ${JSON.stringify(`
            export default defineAutomation(async (ctx, input) => {
              const result = await ctx.actions.searchProducts({
                query: \`${"${input.query}"} under ${"${input.maxPrice}"}\`,
              });
              for (const product of result.products) console.log(product);
              return result;
            });
          `)},
        });
      `,
      ),
    /Thresholds must be applied with a TypeScript filter/,
  );
});

test("composition refuses ambiguous library matches before discovery", async () => {
  const first = catalogSearch("shop.example.com");
  const second = {
    ...first,
    id: "shop.search-docs",
    name: "searchDocumentation",
    description: "Search the site's help catalog",
  };
  const registry = createMemoryRegistry([first, second]);
  let discoveries = 0;
  const session = createCompositionSession({
    registry,
    discover: async () => {
      discoveries += 1;
      return first;
    },
    saveAutomation: async () => undefined,
  });
  await session.list("shop.example.com");
  await assert.rejects(
    () =>
      session.discover({
        siteId: "shop.example.com",
        intent: "search",
      }),
    /ambiguous/,
  );
  assert.equal(discoveries, 0);
});

test("composition discovers dependent stages once within one prompt", async () => {
  const prerequisiteCalls: string[][] = [];
  const session = createCompositionSession({
    registry: createMemoryRegistry(),
    discover: async (need, prerequisites) => {
      prerequisiteCalls.push([...(prerequisites ?? [])]);
      if (need.name === "searchProducts") return catalogSearch("shop.example.com");
      return defineAction({
        id: "shop.open-product",
        siteId: "shop.example.com",
        name: "openProduct",
        description: "Open one product from a catalog result",
        inputs: { product: productRef() },
        outputs: {},
        safety: "read-only",
        steps: [
          navigate({
            id: "open",
            url: inputRef("product.href"),
            safety: "read-only",
          }),
        ],
      });
    },
    saveAutomation: async () => undefined,
  });
  const prepared = await runCompositionCode(
    session,
    `
      return await tools.prepareComposition({
        siteId: "shop.example.com",
        task: "Search then open a product.",
        needs: [
          { stage: "search", name: "searchProducts", intent: "search products", cardinality: "once" },
          { stage: "open", name: "openProduct", intent: "open a product", after: ["search"], cardinality: "once" },
        ],
      });
    `,
  );
  const payload = unwrapCodeModeValue(prepared.value) as {
    discovered: Array<{ name: string }>;
  };
  assert.deepEqual(
    payload.discovered.map((action) => action.name),
    ["searchProducts", "openProduct"],
  );
  assert.deepEqual(prerequisiteCalls, [[], ["searchProducts"]]);
});

test("composition passes ordered reused actions into the one discovery context", async () => {
  const search = catalogSearch("shop.example.com");
  let prerequisiteActions: string[] | undefined;
  const session = createCompositionSession({
    registry: createMemoryRegistry([search]),
    discover: async (_need, prerequisites) => {
      prerequisiteActions = prerequisites;
      return defineAction({
        id: "shop.open-product",
        siteId: "shop.example.com",
        name: "openProduct",
        description: "Open one product from a catalog result",
        inputs: { product: productRef() },
        outputs: {},
        safety: "read-only",
        steps: [
          navigate({
            id: "open",
            url: inputRef("product.href"),
            safety: "read-only",
          }),
        ],
      });
    },
    saveAutomation: async () => undefined,
  });
  await runCompositionCode(
    session,
    `
      return await tools.prepareComposition({
        siteId: "shop.example.com",
        task: "Open a mug.",
        needs: [
          { stage: "search", name: "searchProducts", intent: "search products", cardinality: "once" },
          { stage: "open", name: "openProduct", intent: "open a product", after: ["search"], cardinality: "once" },
        ],
      });
    `,
  );
  assert.deepEqual(prerequisiteActions, ["searchProducts"]);
});

function catalogSearch(siteId: string) {
  return defineAction({
    id: "shop.search-products",
    siteId,
    name: "searchProducts",
    description: "Search the site's product catalog using a text query",
    aliases: ["search the catalog", "look up items", "find products"],
    inputs: { query: string() },
    outputs: { products: array(productRef()) },
    safety: "browser-local",
    steps: [
      fill({
        id: "query",
        locator: label("Search"),
        value: inputRef("query"),
        safety: "browser-local",
      }),
      click({
        id: "submit",
        locator: role("button", { name: "Search" }),
        safety: "browser-local",
      }),
      extractList({
        id: "products",
        locator: testId("product"),
        output: "products",
        fields: {
          href: hrefField(),
          title: textField(testId("title")),
          price: textField(testId("price")),
        },
        safety: "read-only",
      }),
    ],
  });
}

function workflowAction(name: string, description: string, context: string) {
  return defineAction({
    id: `books.${name}`,
    siteId: "books.example.com",
    name,
    description,
    contexts: [context],
    inputs: {},
    outputs: {},
    safety: "read-only",
    steps: [
      click({
        id: `${name}-step`,
        locator: role("button", { name }),
        safety: "read-only",
      }),
    ],
  });
}

test("discovery replays the complete transitive prefix without unrelated stages", async () => {
  const calls: Array<{ name: string; prerequisites: string[] }> = [];
  const session = createCompositionSession({
    registry: createMemoryRegistry(),
    discover: async (need, prerequisites) => {
      calls.push({ name: need.name!, prerequisites: prerequisites ?? [] });
      return defineAction({
        id: `example.${need.name}`,
        siteId: "example.com",
        name: need.name!,
        description: "Reusable operation",
        inputs: {},
        outputs: {},
        safety: "read-only",
        steps: [navigate({ id: "go", url: "https://example.com", safety: "read-only" })],
      });
    },
    saveAutomation: async () => undefined,
  });
  await runCompositionCode(
    session,
    `return await tools.prepareComposition({siteId: "example.com", task: "Read item pages", needs: [
    {stage: "collect", name: "collectReferences", cardinality: "once"},
    {stage: "next", name: "navigateNext", cardinality: "once"},
    {stage: "open", name: "openRecord", intent: "open each record", after: ["collect"], cardinality: "per-item"},
    {stage: "read", name: "extractRecord", intent: "extract record content", after: ["open"], cardinality: "per-item"}
  ]});`,
  );
  assert.deepEqual(calls, [
    { name: "collectReferences", prerequisites: [] },
    { name: "navigateNext", prerequisites: [] },
    { name: "openRecord", prerequisites: ["collectReferences"] },
    { name: "extractRecord", prerequisites: ["collectReferences", "openRecord"] },
  ]);
});

test("URL downloads are runtime work while actual download controls remain site actions", () => {
  const projected = projectSemanticWorkflow([
    { stage: "extract", name: "extractImage", intent: "extract image URL" },
    {
      stage: "download",
      name: "downloadImage",
      intent: "download image using the absolute URL",
      after: ["extract"],
    },
    { stage: "open", name: "openRecord", intent: "open another record", after: ["download"] },
    { stage: "export", name: "clickExport", intent: "click download button to generate an export" },
  ]);
  assert.deepEqual(
    projected.runtimeHandled.map((n) => n.stage),
    ["download"],
  );
  assert.deepEqual(
    projected.needs.map((n) => n.stage),
    ["extract", "open", "export"],
  );
  assert.deepEqual(projected.needs[1]!.after, ["extract"]);
});

test("finishComposition accepts canonical action spelling without changing workflow semantics", async () => {
  const actions = [
    workflowAction("collectDocumentationLinks", "Collect links", "documentation index"),
    workflowAction("openDocumentationPage", "Open a page", "documentation page"),
    workflowAction("extractDocumentationContent", "Read a page", "documentation page"),
  ];
  let saved = 0;
  const session = createCompositionSession({
    registry: createMemoryRegistry(actions),
    discover: async () => {
      throw new Error("Must reuse canonical actions");
    },
    saveAutomation: async () => {
      saved++;
    },
  });
  const result = await runCompositionCode(
    session,
    `
    const needs = [
      { stage: "collect", name: "collect-documentation-links", intent: "collect links", context: "documentation index", cardinality: "once" },
      { stage: "open", name: "open_documentation_page", intent: "open a page", context: "documentation page", after: ["collect"], cardinality: "per-item" },
      { stage: "extract", name: "extract-documentation-content", intent: "read a page", context: "documentation page", after: ["open"], cardinality: "per-item" }
    ];
    await tools.prepareComposition({ siteId: "books.example.com", task: "Read linked documentation", needs });
    const names = ["collectDocumentationLinks", "openDocumentationPage", "extractDocumentationContent"];
    return await tools.finishComposition({
      siteId: "books.example.com", task: "Read linked documentation",
      needs: needs.map((need, index) => ({ ...need, name: names[index] })),
      automationSource: ${JSON.stringify(`export default defineAutomation(async (ctx) => {
        await ctx.actions.collectDocumentationLinks();
        for (const item of [1]) {
          await ctx.actions.openDocumentationPage();
          await ctx.actions.extractDocumentationContent();
        }
      });`)}
    });
  `,
  );
  assert.equal(parseTerminalComposition(result.value).status, "composed");
  assert.equal(saved, 1);
});

test("workflow projection preserves navigation to collected URLs", () => {
  for (const cardinality of ["once", "per-item"] as const) {
    const projected = projectSemanticWorkflow([
      { stage: "collect", name: "collectLinks", intent: "collect links", cardinality: "once" },
      {
        stage: "open",
        name: "openDocument",
        intent: "open selected documentation link",
        description:
          "Open the collected documentation URL so its individual page can be inspected.",
        after: ["collect"],
        cardinality,
      },
      {
        stage: "extract",
        name: "extractContent",
        intent: "extract page content",
        after: ["open"],
        cardinality,
      },
    ]);
    assert.deepEqual(projected.runtimeHandled, []);
    assert.deepEqual(
      projected.needs.map((need) => need.stage),
      ["collect", "open", "extract"],
    );
    assert.deepEqual(projected.needs[2]?.after, ["open"]);
  }
});

test("discovery passes the observed destination to composition without pinning the action", async () => {
  const observedPage = {
    url: "https://shop.example.com/reference/create",
    title: "Creation reference",
  };
  const action = workflowAction(
    "readReference",
    "Read the current reference page",
    "reference page",
  );
  const session = createCompositionSession({
    registry: createMemoryRegistry([]),
    discover: async () => ({
      action,
      observedPage,
      metrics: { modelRequests: 1, codeExecutions: 1, nestedToolCalls: 1 },
    }),
    saveAutomation: async () => undefined,
  });
  await session.list("shop.example.com");
  const found = await session.discover({
    siteId: "shop.example.com",
    name: "readReference",
    context: "Reference page for document 113 at https://shop.example.com/reference/create",
  });
  assert.deepEqual(found.contexts, ["reference page"]);
  assert.deepEqual(found.observedPage, observedPage);
  assert.equal("observedPage" in (await session.get(action.id))!, false);
});

test("planning navigation observations do not become actions, dependencies or execution prerequisites", async () => {
  const { startFixtureServer, withBrowser } = await import("../../runtime/index.js");
  const fixture = await startFixtureServer({
    "/": { html: '<main><a href="/reference">Reference</a></main>' },
    "/reference": { html: "<main><h1>Reference</h1></main>" },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry();
      const prerequisites: string[][] = [];
      const session = createCompositionSession({
        registry,
        discover: async (_need, prefix) => {
          prerequisites.push(prefix ?? []);
          return defineAction({
            id: "reference.open",
            siteId,
            name: "openReference",
            description: "Open the reference",
            inputs: {},
            outputs: {},
            safety: "read-only",
            steps: [
              navigate({
                id: "open",
                url: new URL("/reference", fixture.url).href,
                safety: "read-only",
              }),
            ],
          });
        },
        saveAutomation: async () => undefined,
      });
      const result = await runCompositionCode(
        session,
        `
        const observation = await tools.inspectNavigation({});
        if (observation.links.length !== 1) throw new Error("Missing navigation evidence");
        const prepared = await tools.prepareComposition({
          siteId: ${JSON.stringify(siteId)}, task: "Open the reference",
          needs: [{ stage: "open", name: "openReference", intent: "Open the reference", cardinality: "once" }],
        });
        let rejected = false;
        try {
          await tools.finishComposition({ siteId: ${JSON.stringify(siteId)}, task: "Open the reference",
            automationSource: 'export default defineAutomation(async () => { return {}; });' });
        } catch (error) { rejected = String(error).includes("must call action"); }
        if (!rejected) throw new Error("Observation replaced required navigation");
        return await tools.finishComposition({ siteId: ${JSON.stringify(siteId)}, task: "Open the reference",
          automationSource: 'export default defineAutomation(async (ctx) => { await ctx.actions.openReference({}); return {}; });' });
      `,
        { browser, startUrl: fixture.url, compact: true },
      );
      const terminal = parseTerminalComposition(result.value);
      assert.deepEqual(terminal.automation.actionIds, ["reference.open"]);
      assert.deepEqual(prerequisites, [[]]);
      assert.deepEqual(
        (await registry.list(siteId)).map((action) => action.name),
        ["openReference"],
      );
      assert.equal(browser.contexts().length, 0);
    });
  } finally {
    await fixture.close();
  }
});

test("invalid discovery names are rejected before launching nested browser discovery", async () => {
  let discoveries = 0;
  const session = createCompositionSession({
    registry: createMemoryRegistry(),
    discover: async () => {
      discoveries++;
      return catalogSearch("shop.example.com");
    },
    saveAutomation: async () => undefined,
  });
  await session.list("shop.example.com");
  await assert.rejects(
    session.discover({ siteId: "shop.example.com", name: "searchAndOpenCheapestProduct" }),
    /Task-specific action/,
  );
  assert.equal(discoveries, 0);
});

test("grouped preparation consumes saved results without rediscovering them", async () => {
  const registry = createMemoryRegistry();
  const session = createCompositionSession({
    registry,
    discover: async () => {
      throw new Error("Must not call single-action discovery after a successful batch");
    },
    saveAutomation: async () => {},
  });
  let batches = 0;
  const actions = [
    workflowAction("openReference", "Open the reference", "reference"),
    workflowAction("readReference", "Read the reference", "reference"),
  ];
  const result = await runCompositionCode(
    session,
    `return await tools.prepareComposition({siteId: "books.example.com", task: "Read the reference", needs: [{stage:"open",name:"openReference"},{stage:"read",name:"readReference",after:["open"]}]});`,
    {
      discoverBatch: async (stages) => {
        batches++;
        assert.deepEqual(
          stages.map((stage) => stage.prerequisites),
          [[], ["openReference"]],
        );
        for (const action of actions) await registry.save(action);
        return { actions: await session.list("books.example.com"), metrics: { modelRequests: 1 } };
      },
    },
  );
  const value = unwrapCodeModeValue(result.value) as {
    discovered: Array<{ discoveryMetrics?: unknown }>;
  };
  assert.equal(value.discovered.length, 2);
  assert.equal(value.discovered.filter((item) => item.discoveryMetrics).length, 1);
  assert.equal(batches, 1);
});

test("negated prose does not reject discovery or cause rediscovery after persistence", async () => {
  const action = defineAction({
    id: "drawing.create-marker",
    siteId: "drawing.example.com",
    name: "createMarker",
    description: "Create a marker",
    inputs: {},
    outputs: {},
    safety: "browser-local",
    steps: [
      click({
        id: "add",
        locator: role("button", { name: "Add marker" }),
        safety: "browser-local",
      }),
      fill({ id: "value", locator: label("Value"), value: "#800080", safety: "browser-local" }),
    ],
  });
  const registry = createMemoryRegistry();
  let discoveries = 0;
  let saved: ComposedAutomation | undefined;
  const session = createCompositionSession({
    registry,
    discover: async () => {
      throw new Error("Unexpected repeated discovery");
    },
    saveAutomation: async (automation) => {
      saved = automation;
    },
  });
  const result = await runCompositionCode(
    session,
    `
    const request={siteId:"drawing.example.com",task:"Erstelle eine lila Markierung",needs:[{stage:"create",name:"createMarker",description:"Create a purple marker; do not omit its color or create another item",cardinality:"once"}]};
    await tools.prepareComposition(request);
    return await tools.finishComposition({siteId:request.siteId,task:request.task,automationId:"create-marker",automationSource:"export default defineAutomation(async ctx => {await ctx.actions.createMarker({});});"});
  `,
    {
      compact: true,
      discoverBatch: async () => {
        discoveries++;
        await registry.save(action);
        return { metrics: {}, actions: [action] };
      },
    },
  );
  assert.equal((unwrapCodeModeValue(result.value) as { status: string }).status, "composed");
  assert.equal(discoveries, 1);
  assert.deepEqual(saved?.actionIds, [action.id]);
});

test("a discovered navigation action survives preparation and final composition without rediscovery", async () => {
  const action = defineAction({
    id: "workspace.open-workspace",
    siteId: "workspace.example.com",
    name: "openWorkspace",
    description: "Open an item's workspace",
    contexts: ["Item detail"],
    inputs: {},
    outputs: {},
    safety: "read-only",
    steps: [
      navigate({ id: "item", url: "https://workspace.example.com/items/7", safety: "read-only" }),
      click({ id: "workspace", locator: role("link", { name: "Workspace" }), safety: "read-only" }),
    ],
  });
  const registry = createMemoryRegistry();
  let batches = 0;
  let saved: ComposedAutomation | undefined;
  const task = "Open the workspace using a link";
  const session = createCompositionSession({
    registry,
    task,
    discover: async () => {
      throw new Error("Unexpected rediscovery");
    },
    saveAutomation: async (automation) => {
      saved = automation;
    },
  });
  const result = await runCompositionCode(
    session,
    `
    const request={siteId:"workspace.example.com",task:${JSON.stringify(task)},needs:[{stage:"open",name:"openWorkspace",description:"Open the workspace from the listing using the observed item link",context:"Item detail",cardinality:"once"}]};
    await tools.prepareComposition(request);
    await tools.prepareComposition(request);
    return await tools.finishComposition({siteId:request.siteId,task:"Open the workspace from the listing using a link",automationId:"open-workspace",automationSource:'export default defineAutomation(async ctx => { return await ctx.actions.openWorkspace({}); });'});
  `,
    {
      compact: true,
      discoverBatch: async () => {
        batches++;
        await registry.save(action);
        return { actions: [action], metrics: {} };
      },
    },
  );
  assert.equal((unwrapCodeModeValue(result.value) as { status: string }).status, "composed");
  assert.equal(batches, 1);
  assert.deepEqual(saved?.actionIds, [action.id]);
});

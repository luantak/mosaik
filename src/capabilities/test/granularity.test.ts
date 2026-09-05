import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  click,
  extractList,
  fill,
  hrefField,
  inputRef,
  label,
  role,
  testId,
  textField,
} from "../../core/index.js";
import { openFileRepository } from "../../persist/repository.js";
import {
  array,
  classifyActionGranularity,
  composeTask,
  createMemoryRegistry,
  defineAction,
  normalizeCapabilityNeed,
  planTask,
  productRef,
  string,
} from "../index.js";

const SITE_CAPABILITIES = [
  "searchFlights",
  "searchTickets",
  "searchPatients",
  "searchIssues",
  "searchProducts",
  "openProduct",
  "addToCart",
  "getPrice",
  "searchDocumentation",
  "placeOrder",
  "fillEmail",
  "applyCoupon",
];

const TASK_SPECIFIC = [
  "searchRedShoesUnder100",
  "openCheapestMug",
  "addAllCheapProductsToCart",
  "searchForMugAndOpen",
  "searchForMugAndOpenCheapestUnder20",
];

test("treats reusable names as site capabilities", () => {
  for (const name of SITE_CAPABILITIES) {
    assert.equal(classifyActionGranularity({ name }).kind, "site-capability", name);
  }
});

test("explicit extraction names are not rewritten by incidental words in descriptions", () => {
  assert.deepEqual(
    normalizeCapabilityNeed({
      name: "extractQuotes",
      intent: "extract items from the current page",
      description: "Extract records from the currently open quotes page",
    }),
    {
      name: "extractQuotes",
      intent: "extract items from the current page",
      description: "Extract records from the currently open quotes page",
    },
  );
});

test("treats task-bound names as automation logic", () => {
  for (const name of TASK_SPECIFIC) {
    const verdict = classifyActionGranularity({ name });
    assert.equal(verdict.kind, "task-specific", name);
  }
});

test("will not save a task-specific action", async () => {
  const registry = createMemoryRegistry();
  await assert.rejects(
    () => registry.save(taskSpecificSearch("shop.example.com")),
    /Task-specific action belongs in the automation/,
  );
  assert.deepEqual(await registry.list("shop.example.com"), []);
});

test("will not discover a task-specific action", async () => {
  const registry = createMemoryRegistry();
  let discovered = 0;
  await assert.rejects(
    () =>
      composeTask(registry, {
        siteId: "shop.example.com",
        task: "Search for red shoes under €100.",
        needs: [{ name: "searchRedShoesUnder100" }],
        discover: async () => {
          discovered += 1;
          return taskSpecificSearch("shop.example.com");
        },
      }),
    /Cannot learn task-specific action searchRedShoesUnder100/,
  );
  assert.equal(discovered, 0);
  assert.deepEqual(await registry.list("shop.example.com"), []);
});

test("a unique same-verb action does not satisfy an unrelated or task-specific need", async () => {
  const registry = createMemoryRegistry([catalogSearch("shop.example.com")]);
  for (const name of ["searchFlights", "searchTickets", "searchRedShoesUnder100"]) {
    const plan = await planTask(registry, {
      siteId: "shop.example.com",
      task: "Search the requested domain",
      needs: [{ name }],
    });
    assert.equal(plan.matches[0]?.via, "none");
    assert.deepEqual(plan.reuse, []);
    assert.deepEqual(plan.missing, [{ name }]);
  }
});

test("does not guess when two search actions already exist", async () => {
  const registry = createMemoryRegistry([
    catalogSearch("shop.example.com"),
    defineAction({
      id: "shop.search-docs",
      siteId: "shop.example.com",
      name: "searchDocumentation",
      description: "Search the site's help catalog",
      inputs: { query: string() },
      safety: "browser-local",
      steps: [
        fill({
          id: "query",
          locator: label("Help"),
          value: inputRef("query"),
          safety: "browser-local",
        }),
      ],
    }),
  ]);
  const plan = await planTask(registry, {
    siteId: "shop.example.com",
    task: "Search for red shoes under €100.",
    needs: [{ name: "searchRedShoesUnder100" }],
  });
  assert.equal(plan.matches[0]?.via, "none");
  assert.deepEqual(plan.reuse, []);

  await assert.rejects(
    () =>
      composeTask(registry, {
        siteId: "shop.example.com",
        task: "Search for red shoes under €100.",
        needs: [{ name: "searchRedShoesUnder100" }],
        discover: async () => {
          throw new Error("must not invent a task-specific action");
        },
      }),
    /Cannot learn task-specific action searchRedShoesUnder100/,
  );
});

test("file repository also refuses a task-specific save", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-c19-"));
  try {
    const registry = openFileRepository(root).siteActions;
    await assert.rejects(
      () => registry.save(taskSpecificSearch("shop.example.com")),
      /Task-specific action belongs in the automation/,
    );
    assert.deepEqual(await registry.list("shop.example.com"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function catalogSearch(siteId: string) {
  return defineAction({
    id: "shop.search-products",
    siteId,
    name: "searchProducts",
    description: "Search the site's product catalog using a text query",
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

function taskSpecificSearch(siteId: string) {
  return defineAction({
    id: "shop.search-red-shoes-under-100",
    siteId,
    name: "searchRedShoesUnder100",
    description: "Search for red shoes under 100",
    outputs: { products: array(productRef()) },
    safety: "browser-local",
    steps: [
      fill({
        id: "query",
        locator: label("Search"),
        value: "red shoes",
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

test("domain vocabulary stays reusable and name normalization is idempotent", () => {
  for (const name of [
    "collectBookReferences",
    "extractBookCoverUrlsFromCurrentPage",
    "openInvoice",
    "extractPatientRecords",
    "navigateToNextBooksPage",
  ]) {
    assert.equal(classifyActionGranularity({ name }).kind, "site-capability");
    const need = { name, intent: "Read the current page" };
    assert.deepEqual(normalizeCapabilityNeed(need), need);
    assert.deepEqual(normalizeCapabilityNeed(normalizeCapabilityNeed(need)), need);
  }
});

test("domain search actions can be discovered and reused without renaming", async () => {
  const siteId = "portal.example.com";
  const registry = createMemoryRegistry([catalogSearch(siteId)]);
  for (const name of ["searchFlights", "searchIssues"]) {
    const need = { name, intent: "Search matching items" };
    assert.deepEqual(normalizeCapabilityNeed(need), need);
    const result = await composeTask(registry, {
      siteId,
      task: need.intent,
      needs: [need],
      discover: async () =>
        defineAction({
          id: name,
          siteId,
          name,
          description: need.intent,
          inputs: { query: string() },
          safety: "browser-local",
          steps: [
            fill({
              id: "query",
              locator: label("Search"),
              value: inputRef("query"),
              safety: "browser-local",
            }),
          ],
        }),
    });
    assert.deepEqual(result.discovered, [name]);
    assert.deepEqual(result.reused, []);
    const plan = await planTask(registry, { siteId, task: need.intent, needs: [need] });
    assert.deepEqual(
      plan.reuse.map((action) => action.name),
      [name],
    );
  }
});

test("explicit aliases require a unique action in the requested context", async () => {
  const siteId = "portal.example.com";
  const action = {
    ...catalogSearch(siteId),
    aliases: ["findCatalogEntries"],
    contexts: ["listing"],
  };
  const registry = createMemoryRegistry([action]);
  const plan = (context: string) =>
    planTask(registry, {
      siteId,
      task: "Find catalog entries",
      needs: [{ name: "findCatalogEntries", context }],
    });
  assert.equal((await plan("listing")).matches[0]?.via, "alias");
  assert.deepEqual((await plan("detail")).reuse, []);
  await registry.save({ ...action, id: "second", name: "searchInventory" });
  assert.equal((await plan("listing")).matches[0]?.ambiguous, true);
});

test("read and extraction names may contain verbs describing their subject", () => {
  for (const name of [
    "extractCursorCreateAgentApi",
    "readDeletePolicy",
    "getCreateAccountInstructions",
    "extractCancelOrderReference",
  ]) {
    assert.equal(classifyActionGranularity({ name }).kind, "site-capability", name);
  }
  for (const name of [
    "extractAndCreateAgent",
    "readPolicyThenDelete",
    "extractCheapestProduct",
    "readTop10Results",
  ]) {
    assert.equal(classifyActionGranularity({ name }).kind, "task-specific", name);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { CompileError } from "../../core/compile.js";
import {
  click,
  extractList,
  extractText,
  fill,
  hrefField,
  inputRef,
  label,
  navigate,
  role,
  testId,
  textField,
} from "../../core/index.js";
import { formatDependencies } from "../../automations/index.js";
import {
  actionInterfacesCompatible,
  array,
  capabilities,
  coerceValue,
  composeTask,
  createMemoryRegistry,
  defineAction,
  formatSignature,
  normalizeSiteId,
  number,
  object,
  productRef,
  recordSuccessfulSiteActionReuse,
  string,
} from "../index.js";

test("normalizeSiteId uses the host", () => {
  assert.equal(normalizeSiteId("https://Quotes.Toscrape.com/page/1"), "quotes.toscrape.com");
  assert.equal(normalizeSiteId("shop.example.com"), "shop.example.com");
  assert.equal(normalizeSiteId("http://127.0.0.1:4377/cart"), "127.0.0.1:4377");
});

test("defineAction compiles to existing semantic steps", () => {
  const action = defineAction({
    id: "shop.search-products",
    siteId: "https://shop.example.com/catalog",
    name: "searchProducts",
    description: "Search the site's product catalog using a text query",
    inputs: { query: string() },
    outputs: { title: string() },
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
      extractText({
        id: "title",
        locator: testId("featured-title"),
        output: "title",
        safety: "read-only",
      }),
    ],
  });

  assert.equal(action.siteId, "shop.example.com");
  assert.equal(action.verification, "unverified");
  assert.equal(action.implementation.steps.length, 3);
  assert.equal(action.implementation.steps[0]?.type, "fill");
  assert.equal(
    formatSignature(action),
    "searchProducts(args: { query: string }) -> { title: string }",
  );
});

test("defineAction rejects weak safety and missing extract outputs", () => {
  assert.throws(
    () =>
      defineAction({
        id: "shop.place",
        siteId: "shop.example.com",
        name: "placeOrder",
        description: "Place the current order",
        safety: "read-only",
        steps: [
          click({
            id: "place",
            locator: role("button", { name: "Place order" }),
            safety: "external-side-effect",
          }),
        ],
      }),
    CompileError,
  );

  assert.throws(
    () =>
      defineAction({
        id: "shop.price",
        siteId: "shop.example.com",
        name: "getPrice",
        description: "Read the product price",
        safety: "read-only",
        steps: [
          extractText({
            id: "price",
            locator: testId("price"),
            output: "price",
            safety: "read-only",
          }),
        ],
      }),
    /not in the action outputs schema/,
  );
});

test("capability lookup returns summaries without implementations", async () => {
  const search = defineAction({
    id: "shop.search-products",
    siteId: "shop.example.com",
    name: "searchProducts",
    description: "Search the site's product catalog using a text query",
    inputs: { query: string() },
    outputs: { title: string() },
    safety: "browser-local",
    steps: [
      fill({
        id: "query",
        locator: label("Search"),
        value: inputRef("query"),
        safety: "browser-local",
      }),
      extractText({
        id: "title",
        locator: testId("featured-title"),
        output: "title",
        safety: "read-only",
      }),
    ],
  });
  const open = defineAction({
    id: "shop.open-product",
    siteId: "shop.example.com",
    name: "openProduct",
    description: "Open a product from a catalog result",
    inputs: { product: object({ href: string(), title: string(), price: number() }) },
    safety: "browser-local",
    steps: [navigate({ id: "open", url: "https://shop.example.com/p", safety: "browser-local" })],
  });
  const other = defineAction({
    id: "docs.search",
    siteId: "docs.example.com",
    name: "searchDocumentation",
    description: "Search documentation",
    inputs: { query: string() },
    safety: "read-only",
    steps: [
      fill({
        id: "query",
        locator: label("Search"),
        value: inputRef("query"),
        safety: "read-only",
      }),
    ],
  });

  const registry = createMemoryRegistry([search, open, other]);
  const listed = await capabilities.list(registry, "shop.example.com");
  assert.deepEqual(
    listed.map((entry) => entry.name),
    ["openProduct", "searchProducts"],
  );
  assert.equal("implementation" in listed[0]!, false);
  assert.equal(
    listed.find((entry) => entry.name === "searchProducts")?.signature,
    "searchProducts(args: { query: string }) -> { title: string }",
  );

  const found = await capabilities.search(registry, "shop.example.com", "search the catalog");
  assert.equal(found[0]?.name, "searchProducts");
  assert.equal(
    found.some((entry) => entry.name === "searchDocumentation"),
    false,
  );

  const got = await capabilities.get(registry, "shop.open-product");
  assert.equal(got?.name, "openProduct");
  assert.equal("implementation" in (got ?? {}), false);
  assert.equal(await capabilities.get(registry, "missing"), undefined);
});

test("typed schemas coerce structured outputs and optional product refs", () => {
  const signature = formatSignature({
    name: "searchProducts",
    inputs: { query: string() },
    outputs: { products: array(productRef()) },
  });
  assert.equal(
    signature,
    "searchProducts(args: { query: string }) -> { products: { href: string; title: string; price?: number }[] }",
  );

  const products = coerceValue(
    array(productRef()),
    [
      { href: "/bowl", title: "Mixing bowl", price: "$24.00" },
      { href: "/mug", title: "Ceramic mug" },
    ],
    "products",
  );
  assert.deepEqual(products, [
    { href: "/bowl", title: "Mixing bowl", price: 24 },
    { href: "/mug", title: "Ceramic mug" },
  ]);
});

test("composeTask reuses known actions and discovers only the missing one", async () => {
  const search = catalogSearch("shop.example.com");
  const open = catalogOpen("shop.example.com");
  const add = catalogAddToCart("shop.example.com");
  const registry = createMemoryRegistry([search, open]);
  const discovered: string[] = [];

  const result = await composeTask(registry, {
    siteId: "https://shop.example.com/catalog",
    task: "Search for a mug, open it, and add it to the cart.",
    needs: [{ name: "searchProducts" }, { name: "openProduct" }, { name: "addToCart" }],
    discover: async (need) => {
      discovered.push(need.name ?? "");
      if (need.name !== "addToCart") {
        throw new Error(`unexpected rediscovery of ${need.name}`);
      }
      return add;
    },
  });

  assert.deepEqual(discovered, ["addToCart"]);
  assert.deepEqual(result.reused, ["searchProducts", "openProduct"]);
  assert.deepEqual(result.discovered, ["addToCart"]);
  assert.deepEqual(result.rediscovered, []);
  assert.deepEqual(result.metrics, {
    existingActionsConsidered: 2,
    knownActionsReused: 2,
    missingActionsDiscovered: 1,
    actionsRediscoveredUnnecessarily: 0,
    inspectedBeforeDiscovery: true,
  });
  assert.equal((await registry.list("shop.example.com")).length, 3);
  assert.deepEqual(result.automation.actionIds, [
    "shop.search-products",
    "shop.open-product",
    "shop.add-to-cart",
  ]);
  assert.deepEqual(formatDependencies(result.automation.dependencies ?? []), [
    "shop.search-products@1",
    "shop.open-product@1",
    "shop.add-to-cart@1",
  ]);
  assert.match(result.automation.source, /await searchProducts\(/);
  assert.match(result.automation.source, /searchProductsResult\.products\[0\]/);
  assert.match(result.automation.source, /await openProduct\(/);
  assert.match(result.automation.source, /await addToCart\(/);
});

test("action interface equality is structural and rejects incompatible schemas", () => {
  const products = {
    inputs: { query: string() },
    outputs: { products: array(productRef()) },
  };
  const sameKeysDifferentOrder = {
    outputs: { products: array(productRef()) },
    inputs: { query: string() },
  };
  const breaking = {
    inputs: { term: string() },
    outputs: { results: array(productRef()) },
  };
  assert.equal(actionInterfacesCompatible(products, sameKeysDifferentOrder), true);
  assert.equal(actionInterfacesCompatible(products, breaking), false);
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

function catalogOpen(siteId: string) {
  return defineAction({
    id: "shop.open-product",
    siteId,
    name: "openProduct",
    description: "Open a product from a catalog result",
    inputs: { product: productRef() },
    safety: "browser-local",
    steps: [
      navigate({
        id: "open",
        url: inputRef("product.href"),
        safety: "browser-local",
      }),
    ],
  });
}

function catalogAddToCart(siteId: string) {
  return defineAction({
    id: "shop.add-to-cart",
    siteId,
    name: "addToCart",
    description: "Add the open product to the cart",
    safety: "browser-local",
    steps: [
      click({
        id: "add",
        locator: role("button", { name: "Add to cart" }),
        safety: "browser-local",
      }),
    ],
  });
}

test("memory registry compare-and-swap rejects a stale action version", async () => {
  const search = catalogSearch("c25.memory.example.com");
  const registry = createMemoryRegistry([search]);
  const next = { ...search, version: 2, verification: "unverified" as const };
  const stale = { ...search, version: 2, description: search.description };
  const [first, second] = await Promise.all([
    registry.updateActionIfVersion({
      siteId: search.siteId,
      actionId: search.id,
      expectedVersion: 1,
      next,
    }),
    registry.updateActionIfVersion({
      siteId: search.siteId,
      actionId: search.id,
      expectedVersion: 1,
      next: stale,
    }),
  ]);
  const committed = [first, second].filter((result) => result.updated);
  const conflicts = [first, second].filter((result) => !result.updated);
  assert.equal(committed.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.reason, "version-conflict");
  assert.equal((await registry.get(search.id))?.version, 2);
});

test("a successful site-action reuse promotes an unverified learned action", async () => {
  const search = catalogSearch("reuse.example.com");
  const registry = createMemoryRegistry([search]);
  await recordSuccessfulSiteActionReuse(registry, search.id, 1_700_000_000_000);
  const reused = await registry.get(search.id);
  assert.equal(reused?.verification, "verified");
  assert.equal(reused?.runStats?.successfulRuns, 1);
  assert.equal(reused?.runStats?.lastSuccessAt, 1_700_000_000_000);
});

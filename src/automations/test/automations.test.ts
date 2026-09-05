import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import test from "node:test";
import {
  array,
  composeTask,
  createMemoryRegistry,
  defineAction,
  number,
  object,
  productRef,
  string,
} from "../../capabilities/index.js";
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
  urlField,
} from "../../core/index.js";
import {
  ephemeralSession,
  openInteractiveBrowserSession,
  startFixtureServer,
  withBrowser,
} from "../../runtime/index.js";
import {
  createStubHost,
  executeComposedAutomation,
  runAutomation,
  validateAutomation,
} from "../index.js";

const shop = (name: string) => resolve("fixtures/shop", name);

const loopSource = `
export default defineAutomation(async (ctx, input) => {
  ctx.log("looking for a cheap mug");
  const products = input.products;
  for (const product of products) {
    if (product.price < 20) {
      await ctx.actions.openProduct({ product });
      return { selected: product };
    }
  }
  return { selected: null };
});
`;

test("generated TypeScript with a loop can call registered actions", async () => {
  const opened: unknown[] = [];
  const result = await executeComposedAutomation(
    { id: "buy-cheap-mug", siteId: "shop.example.com", source: loopSource, version: 1 },
    {
      actionNames: ["openProduct"],
      input: {
        products: [
          { title: "A", price: 24 },
          { title: "B", price: 18 },
          { title: "C", price: 12 },
        ],
      },
      host: createStubHost({
        openProduct: (args) => {
          opened.push(args);
          return {};
        },
      }),
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual(result.value, { selected: { title: "B", price: 18 } });
  assert.equal(result.logs.includes("looking for a cheap mug"), true);
  assert.equal(opened.length, 1);
});

test("automation validation rejects disallowed imports, process, and raw Playwright", () => {
  assert.throws(
    () =>
      validateAutomation(`
        import fs from "node:fs";
        export default defineAutomation(async () => {});
      `),
    /Import is not allowed/,
  );
  assert.throws(
    () =>
      validateAutomation(`
        export default defineAutomation(async () => process.exit(0));
      `),
    /Forbidden identifier: process/,
  );
  assert.throws(
    () =>
      validateAutomation(`
        export default defineAutomation(async () => {
          await page.locator("button").click();
        });
      `),
    /Raw browser access is not allowed/,
  );
  assert.throws(
    () =>
      validateAutomation(
        `
        export default defineAutomation(async (ctx) => {
          await ctx.actions.missing();
        });
      `,
        { actionNames: ["openProduct"] },
      ),
    /Unknown action: missing/,
  );
});

test("automation validation requires an exported automation", () => {
  assert.throws(
    () => validateAutomation('defineAutomation("bad", async () => ({}));'),
    /must export exactly one defineAutomation/,
  );
});

test("automation validation rejects duplicate declarations before persistence", () => {
  assert.throws(
    () =>
      validateAutomation(`
        export default defineAutomation(async (ctx, input) => {
          const result = await ctx.actions.searchProducts({ query: input.query });
          const result = await ctx.actions.addToCart({});
          return result;
        });
      `),
    /Automation syntax is invalid: Identifier 'result' has already been declared/,
  );
});

test("DSH automation runtime has bash-equivalent trust", async () => {
  const result = await executeComposedAutomation(
    {
      id: "escape",
      siteId: "shop.example.com",
      source: `
        export default defineAutomation(async (ctx) => {
          const ctor = ctx.log.constructor.constructor;
          return ctor("return 1")();
        });
      `,
      version: 1,
    },
    { host: createStubHost({}) },
  );
  assert.equal(result.success, true);
  assert.equal(result.value, 1);
});

test("DSH automation runtime preserves the action-call budget", async () => {
  let calls = 0;
  const result = await executeComposedAutomation(
    {
      id: "call-budget",
      siteId: "shop.example.com",
      source: `
        export default defineAutomation(async (ctx) => {
          await ctx.actions.read({});
          await ctx.actions.read({});
        });
      `,
      version: 1,
    },
    {
      actionNames: ["read"],
      maxActionCalls: 1,
      host: createStubHost({
        read: () => {
          calls += 1;
          return {};
        },
      }),
    },
  );
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Action call limit of 1 exceeded/);
  assert.equal(calls, 1);
});

test("generated automations can treat an expected missing browser action as a loop boundary", async () => {
  let page = 0;
  const result = await executeComposedAutomation(
    {
      id: "paginate-until-end",
      siteId: "quotes.example.com",
      source: `
        export default defineAutomation(async (ctx) => {
          const collected = [];
          while (true) {
            collected.push((await ctx.actions.readPage({})).item);
            try {
              await ctx.actions.goToNextPage({});
            } catch {
              break;
            }
          }
          return collected;
        });
      `,
      version: 1,
    },
    {
      actionNames: ["readPage", "goToNextPage"],
      host: createStubHost({
        readPage: () => ({ item: `page-${page + 1}` }),
        goToNextPage: () => {
          if (page === 2) throw new Error("Next page is unavailable");
          page += 1;
          return {};
        },
      }),
    },
  );

  assert.equal(result.success, true, result.error);
  assert.deepEqual(result.value, ["page-1", "page-2", "page-3"]);
});

test("DSH automation runtime preserves the execution-time budget", async () => {
  const result = await executeComposedAutomation(
    {
      id: "time-budget",
      siteId: "shop.example.com",
      source: `
        export default defineAutomation(async () => {
          while (true) {}
        });
      `,
      version: 1,
    },
    { timeoutMs: 100, host: createStubHost({}) },
  );
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Automation timed out after 100ms/);
});

test("generated automations can write JSON inside the run output directory", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "mosaik-output-"));
  const result = await executeComposedAutomation(
    {
      id: "write-quotes",
      siteId: "quotes.example.com",
      source: `
        export default defineAutomation(async (ctx) => {
          return ctx.files.write("quotes/first.json", [{ quote: "Hello" }]);
        });
      `,
      version: 1,
    },
    { host: createStubHost({}), outputDirectory },
  );

  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, "quotes/first.json"), "utf8")), [
    { quote: "Hello" },
  ]);
  assert.equal(result.files?.[0]?.relativePath, "quotes/first.json");
});

test("browser-backed downloads reuse loaded bytes and rename collisions", async () => {
  const cover = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path d="M0 0h2v2H0z"/></svg>',
  );
  const manual = Buffer.from("%PDF-1.4\n% fixture\n%%EOF\n");
  const fixture = await startFixtureServer({
    "/": {
      html: '<!doctype html><article class="book"><img src="/cover.svg"><a href="/manual.pdf">Manual</a></article>',
    },
    "/cover.svg": { body: cover, contentType: "image/svg+xml" },
    "/manual.pdf": { body: manual, contentType: "application/pdf" },
  });
  const outputDirectory = await mkdtemp(join(tmpdir(), "mosaik-download-"));
  const browserSession = await openInteractiveBrowserSession({
    startUrl: fixture.url,
    profileDirectory: join(outputDirectory, "profile"),
    headless: true,
  });
  try {
    const siteId = new URL(fixture.url).host;
    const extractBooks = defineAction({
      id: "books.extract-books",
      siteId,
      name: "extractBooks",
      description: "Extract books and their loaded cover URLs",
      outputs: { books: array(object({ coverUrl: string(), manualUrl: string() })) },
      safety: "read-only",
      steps: [
        extractList({
          id: "books",
          locator: { strategy: "css", selector: ".book" },
          output: "books",
          fields: {
            coverUrl: urlField("src", { strategy: "css", selector: "img" }),
            manualUrl: urlField("href", { strategy: "css", selector: "a" }),
          },
          safety: "read-only",
        }),
      ],
    });
    const result = await runAutomation(
      browserSession,
      {
        id: "download-covers",
        siteId,
        version: 1,
        source: `
            export default defineAutomation(async (ctx) => {
              const page = await ctx.actions.extractBooks({});
              const first = await ctx.files.download({
                url: page.books[0].coverUrl,
                path: "covers/cover.svg",
                reuseOnly: true,
              });
              const second = await ctx.files.download({
                url: page.books[0].coverUrl,
                path: "covers/cover.svg",
                reuseOnly: true,
              });
              const manual = await ctx.files.download({
                url: page.books[0].manualUrl,
                path: "documents/manual.pdf",
              });
              let strictCollision = false;
              try {
                await ctx.files.download({
                  url: page.books[0].coverUrl,
                  path: "covers/cover.svg",
                  reuseOnly: true,
                  onConflict: "error",
                });
              } catch (error) {
                strictCollision = String(error).includes("already exists");
              }
              return {
                first: first.relativePath,
                second: second.relativePath,
                manual: manual.relativePath,
                strictCollision,
              };
            });
          `,
      },
      {
        registry: createMemoryRegistry([extractBooks]),
        outputDirectory,
      },
    );

    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.value, {
      first: "covers/cover.svg",
      second: "covers/cover-2.svg",
      manual: "documents/manual.pdf",
      strictCollision: true,
    });
    assert.deepEqual(await readFile(join(outputDirectory, "covers/cover.svg")), cover);
    assert.deepEqual(await readFile(join(outputDirectory, "covers/cover-2.svg")), cover);
    assert.deepEqual(await readFile(join(outputDirectory, "documents/manual.pdf")), manual);
    assert.equal(fixture.requestCount("/cover.svg"), 1);
    assert.equal(fixture.requestCount("/manual.pdf"), 1);
  } finally {
    await browserSession.close();
    await fixture.close();
  }
});

test("generated automation output cannot escape the run directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "mosaik-output-parent-"));
  const outputDirectory = join(parent, "output");
  const result = await executeComposedAutomation(
    {
      id: "escape-output",
      siteId: "quotes.example.com",
      source: `
        export default defineAutomation(async (ctx) => {
          return ctx.files.write("../outside.json", { leaked: true });
        });
      `,
      version: 1,
    },
    { host: createStubHost({}), outputDirectory },
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /cannot contain '\.\.'/);
  await assert.rejects(access(join(parent, "outside.json")));
});

test("a generated automation can run a real site action in the browser", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("discovery-product.html") } });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const getPrice = defineAction({
        id: "shop.get-price",
        siteId,
        name: "getPrice",
        description: "Read the product price on the current page",
        outputs: { price: string() },
        safety: "read-only",
        steps: [
          extractText({
            id: "price",
            locator: testId("price"),
            output: "price",
            safety: "read-only",
          }),
        ],
      });
      const registry = createMemoryRegistry([getPrice]);
      const first = await runAutomation(
        browser,
        {
          id: "initial-read",
          siteId,
          version: 1,
          source: "export default defineAutomation(async ctx => ctx.actions.getPrice());",
        },
        { registry, startUrl: fixture.url, deferVerificationFor: [getPrice.id] },
      );
      assert.equal(first.success, true);
      assert.equal((await registry.get(getPrice.id))?.verification, "unverified");
      const result = await runAutomation(
        browser,
        {
          id: "read-price",
          siteId,
          version: 1,
          source: `
            export default defineAutomation(async (ctx) => {
              const result = await ctx.actions.getPrice();
              return { price: result.price };
            });
          `,
        },
        { registry, startUrl: fixture.url },
      );
      assert.equal(result.success, true);
      assert.deepEqual(result.value, { price: "$18.00" });
      assert.equal((await registry.get(getPrice.id))?.verification, "verified");
      assert.equal((await registry.get(getPrice.id))?.runStats?.successfulRuns, 2);
    });
  } finally {
    await fixture.close();
  }
});

test("CDP-backed sessions allow remote latency when waiting for action targets", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: `<!doctype html><title>Delayed heading</title><body><script>
        setTimeout(() => {
          const heading = document.createElement("h1");
          heading.textContent = "Example Domain";
          document.body.append(heading);
        }, 1750);
      </script></body>`,
    },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const extractHeading = defineAction({
        id: "example.extract-heading",
        siteId,
        name: "extractHeading",
        description: "Read the delayed page heading",
        outputs: { heading: string() },
        safety: "read-only",
        steps: [
          extractText({
            id: "heading",
            locator: role("heading", { name: "Example Domain", exact: true }),
            output: "heading",
            safety: "read-only",
          }),
        ],
      });
      const session = ephemeralSession(browser, { cdpEndpoint: "ws://remote.example.test" });
      const result = await runAutomation(
        session,
        {
          id: "read-delayed-heading",
          siteId,
          version: 1,
          source: `
            export default defineAutomation(async (ctx) => {
              return ctx.actions.extractHeading();
            });
          `,
        },
        { registry: createMemoryRegistry([extractHeading]), startUrl: fixture.url },
      );

      assert.equal(session.defaultStepTimeoutMs, 5_000);
      assert.equal(result.success, true);
      assert.deepEqual(result.value, { heading: "Example Domain" });
    });
  } finally {
    await fixture.close();
  }
});

test("site action inputs resolve through existing fill steps", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("good.html") } });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const fillEmail = defineAction({
        id: "shop.fill-email",
        siteId,
        name: "fillEmail",
        description: "Fill the checkout email field",
        inputs: { email: string() },
        safety: "browser-local",
        steps: [
          fill({
            id: "email",
            locator: label("Email"),
            value: inputRef("email"),
            safety: "browser-local",
          }),
        ],
      });
      const result = await runAutomation(
        browser,
        {
          id: "fill-email",
          siteId,
          version: 1,
          source: `
            export default defineAutomation(async (ctx, input) => {
              await ctx.actions.fillEmail({ email: input.email });
              return { filled: true };
            });
          `,
        },
        {
          registry: createMemoryRegistry([fillEmail]),
          startUrl: fixture.url,
          input: { email: "user@example.com" },
        },
      );
      assert.equal(result.success, true);
      assert.deepEqual(result.value, { filled: true });
    });
  } finally {
    await fixture.close();
  }
});

test("composed TypeScript reuses known actions and follows product refs", async () => {
  const fixture = await startFixtureServer({
    "/": { file: shop("catalog-refs.html") },
    "/mug": { file: shop("product-mug.html") },
    "/bowl": { file: shop("product-bowl.html") },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry([catalogSearch(siteId), catalogOpen(siteId)]);
      const discovered: string[] = [];
      const composed = await composeTask(registry, {
        siteId,
        task: "Search for a mug, open it, and read its price.",
        needs: [{ name: "searchProducts" }, { name: "openProduct" }, { name: "getPrice" }],
        discover: async (need) => {
          discovered.push(need.name ?? "");
          if (need.name !== "getPrice") {
            throw new Error(`unexpected rediscovery of ${need.name}`);
          }
          return catalogPrice(siteId);
        },
        generateAutomation: () => `
export default defineAutomation(async (ctx, input) => {
  const { products } = await ctx.actions.searchProducts({ query: input.query });
  const product = products.find((item) => item.title.toLowerCase().includes("mug"));
  if (!product) throw new Error("mug not found");
  await ctx.actions.openProduct({ product });
  const { price } = await ctx.actions.getPrice();
  return { products, opened: product, price };
});
`,
      });

      assert.deepEqual(discovered, ["getPrice"]);
      assert.equal(composed.metrics.knownActionsReused, 2);
      assert.equal(composed.metrics.missingActionsDiscovered, 1);
      assert.equal(composed.metrics.actionsRediscoveredUnnecessarily, 0);

      const result = await runAutomation(browser, composed.automation, {
        registry,
        startUrl: fixture.url,
        input: { query: "mug" },
      });
      assert.equal(result.success, true, result.error);
      assert.deepEqual(result.value, {
        products: [
          { href: "/bowl", title: "Mixing bowl", price: 24 },
          { href: "/mug", title: "Ceramic mug", price: 18 },
        ],
        opened: { href: "/mug", title: "Ceramic mug", price: 18 },
        price: 18,
      });
    });
  } finally {
    await fixture.close();
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

function catalogPrice(siteId: string) {
  return defineAction({
    id: "shop.get-price",
    siteId,
    name: "getPrice",
    description: "Read the product price on the current page",
    outputs: { price: number("currency-decimal-point") },
    safety: "read-only",
    steps: [
      extractText({
        id: "price",
        locator: testId("price"),
        output: "price",
        safety: "read-only",
      }),
    ],
  });
}

test("malformed automation separators report source syntax instead of a missing export", () => {
  const lines = [
    'import { defineAutomation } from "mosaik/automations";',
    "export default defineAutomation(async (ctx, input) => { return {}; });",
  ];
  assert.throws(() => validateAutomation(lines.join("\\n")), /actual line breaks/);
  assert.doesNotThrow(() => validateAutomation(lines.join("\n")));
});

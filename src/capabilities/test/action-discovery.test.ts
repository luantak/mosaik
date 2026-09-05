import assert from "node:assert/strict";
import test from "node:test";
import { extractList, extractText, inputRef, navigate, role } from "../../core/index.js";
import { createActionDiscoverySession, defaultActionId } from "../action-discovery.js";
import { createMemoryRegistry } from "../lookup.js";
import { array, object, string } from "../schema.js";

test("default action ids stay site-local", () => {
  assert.equal(
    defaultActionId("https://shop.example.com/path", "searchProducts"),
    "shop.search-products",
  );
});

test("atomic submission saves a reusable action", async () => {
  const registry = createMemoryRegistry();
  const session = createActionDiscoverySession({ registry, siteId: "shop.example.com" });
  const result = await session.submit({
    name: "readHeading",
    description: "Read the current page heading",
    inputs: {},
    outputs: { heading: string() },
    safety: "read-only",
    steps: [
      extractText({
        id: "heading",
        locator: role("heading"),
        output: "heading",
        safety: "read-only",
      }),
    ],
  });

  assert.equal(result.status, "discovered");
  assert.equal((await registry.list("shop.example.com"))[0]?.name, "readHeading");
  assert.equal(session.preview().draft.name, "readHeading");
});

test("rejected atomic submissions do not alter the session or registry", async () => {
  const registry = createMemoryRegistry();
  const session = createActionDiscoverySession({
    registry,
    siteId: "shop.example.com",
    allowedSafety: ["read-only"],
  });
  await assert.rejects(
    session.submit({
      name: "openProduct",
      description: "Open a product page",
      inputs: { href: string() },
      outputs: {},
      safety: "browser-local",
      steps: [
        navigate({
          id: "open",
          url: inputRef("href"),
          safety: "browser-local",
        }),
      ],
    }),
    /outside the discovery policy/,
  );
  assert.equal(session.preview().draft.name, undefined);
  assert.deepEqual(await registry.list("shop.example.com"), []);
});

test("list outputs must match compiled fields", async () => {
  const session = createActionDiscoverySession({
    registry: createMemoryRegistry(),
    siteId: "shop.example.com",
  });
  await assert.rejects(
    session.submit({
      name: "listProducts",
      description: "List products on the current page",
      inputs: {},
      outputs: {
        products: array(object({ title: string(), href: string() })),
      },
      safety: "read-only",
      steps: [
        extractList({
          id: "products",
          locator: role("listitem"),
          output: "products",
          fields: { title: { source: "text" } },
          safety: "read-only",
        }),
      ],
    }),
    /products.href has no compiled field/,
  );
});

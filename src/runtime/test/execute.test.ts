import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import {
  automation,
  click,
  compile,
  extractList,
  extractText,
  fill,
  hrefField,
  inputRef,
  label,
  navigate,
  role,
  select,
  testId,
  textField,
  urlField,
} from "../../core/index.js";
import { shopCheckout, shopPlaceOrder, shopUnavailable } from "../../fixtures/shop.js";
import { executeAutomation, startFixtureServer, withBrowser } from "../index.js";

const shop = (name: string) => resolve("fixtures/shop", name);

test("happy path executes navigate, fill, select, and click", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("good.html") } });
  try {
    await withBrowser(async (browser) => {
      const result = await executeAutomation(browser, shopCheckout(fixture.url));
      assert.equal(result.success, true);
      assert.equal(result.automation.runStats?.successfulRuns, 1);
      assert.equal(result.automation.runStats?.failedRuns, 0);
      assert.equal(typeof result.automation.runStats?.lastSuccessAt, "number");
      assert.equal(
        result.events.some((event) => event.type === "run.finished" && event.outcome === "success"),
        true,
      );
    });
  } finally {
    await fixture.close();
  }
});

test("input-referenced fill values resolve at runtime", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("good.html") } });
  try {
    await withBrowser(async (browser) => {
      const automation = compile({
        id: "checkout-inputs",
        version: 1,
        actions: [
          {
            id: "checkout-inputs/main",
            name: "checkout-inputs",
            steps: [
              navigate({ id: "open", url: fixture.url, safety: "browser-local" }),
              fill({
                id: "email",
                locator: label("Email"),
                value: inputRef("email"),
                safety: "browser-local",
              }),
              select({
                id: "country",
                locator: label("Country"),
                value: "DE",
                safety: "browser-local",
              }),
              click({
                id: "continue",
                locator: role("button", { name: "Continue" }),
                safety: "browser-local",
              }),
            ],
          },
        ],
      });
      const result = await executeAutomation(browser, automation, {
        inputs: { email: "user@example.com" },
      });
      assert.equal(result.success, true);
    });
  } finally {
    await fixture.close();
  }
});

test("extract-text writes a named output", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("discovery-product.html") } });
  try {
    await withBrowser(async (browser) => {
      const result = await executeAutomation(
        browser,
        automation("mug-price", () => [
          navigate({ id: "open", url: fixture.url, safety: "browser-local" }),
          extractText({
            id: "price",
            locator: testId("price"),
            output: "price",
            safety: "read-only",
          }),
        ]),
      );
      assert.equal(result.success, true);
      assert.equal(result.outputs.price, "$18.00");
      assert.equal(
        result.events.some(
          (event) =>
            event.type === "step.succeeded" && event.output === "price" && event.value === "$18.00",
        ),
        true,
      );
    });
  } finally {
    await fixture.close();
  }
});

test("extract-list writes structured product rows", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("catalog-refs.html") } });
  try {
    await withBrowser(async (browser) => {
      const result = await executeAutomation(
        browser,
        automation("catalog", () => [
          navigate({ id: "open", url: fixture.url, safety: "browser-local" }),
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
        ]),
      );
      assert.equal(result.success, true);
      assert.deepEqual(JSON.parse(result.outputs.products ?? "[]"), [
        { href: "/bowl", title: "Mixing bowl", price: "$24.00" },
        { href: "/mug", title: "Ceramic mug", price: "$18.00" },
      ]);
    });
  } finally {
    await fixture.close();
  }
});

test("extract-list can use the repeated row itself as a text field", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("catalog-refs.html") } });
  try {
    await withBrowser(async (browser) => {
      const row = testId("product");
      const result = await executeAutomation(
        browser,
        automation("catalog-row-text", () => [
          navigate({ id: "open", url: fixture.url, safety: "browser-local" }),
          extractList({
            id: "products",
            locator: row,
            output: "products",
            fields: {
              href: hrefField(),
              title: textField(row),
              price: textField(row),
            },
            safety: "read-only",
          }),
        ]),
      );
      assert.equal(result.success, true);
      assert.deepEqual(JSON.parse(result.outputs.products ?? "[]"), [
        { href: "/bowl", title: "Mixing bowl $24.00", price: "Mixing bowl $24.00" },
        { href: "/mug", title: "Ceramic mug $18.00", price: "Ceramic mug $18.00" },
      ]);
    });
  } finally {
    await fixture.close();
  }
});

test("extract-list can read an absolute URL from the repeated image itself", async () => {
  const fixture = await startFixtureServer({
    "/": { html: '<img class="cover" src="/covers/full.jpg">' },
    "/covers/full.jpg": { body: "image bytes", contentType: "image/jpeg" },
  });
  try {
    await withBrowser(async (browser) => {
      const cover = { strategy: "css" as const, selector: ".cover" };
      const result = await executeAutomation(
        browser,
        automation("cover-url", () => [
          navigate({ id: "open", url: fixture.url, safety: "browser-local" }),
          extractList({
            id: "covers",
            locator: cover,
            output: "covers",
            fields: { fileUrl: urlField("src", cover) },
            safety: "read-only",
          }),
        ]),
      );

      assert.equal(result.success, true);
      assert.deepEqual(JSON.parse(result.outputs.covers ?? "[]"), [
        { fileUrl: `${fixture.origin}/covers/full.jpg` },
      ]);
    });
  } finally {
    await fixture.close();
  }
});

test("navigate resolves a relative product href from an input ref", async () => {
  const fixture = await startFixtureServer({
    "/": { file: shop("catalog-refs.html") },
    "/mug": { file: shop("product-mug.html") },
  });
  try {
    await withBrowser(async (browser) => {
      const result = await executeAutomation(
        browser,
        automation("open-mug", () => [
          navigate({ id: "open", url: fixture.url, safety: "browser-local" }),
          navigate({
            id: "product",
            url: inputRef("product.href"),
            safety: "browser-local",
          }),
          extractText({
            id: "price",
            locator: testId("price"),
            output: "price",
            safety: "read-only",
          }),
        ]),
        { inputs: { product: { href: "/mug" } } },
      );
      assert.equal(result.success, true);
      assert.equal(result.outputs.price, "$18.00");
    });
  } finally {
    await fixture.close();
  }
});

test("semantic locator still works after a DOM move", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("moved-button.html") } });
  try {
    await withBrowser(async (browser) => {
      const result = await executeAutomation(browser, shopCheckout(fixture.url));
      assert.equal(result.success, true);
      assert.equal(result.failure, undefined);
    });
  } finally {
    await fixture.close();
  }
});

test("a target that appears within the locator timeout is not a repair case", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("delayed-within.html") } });
  try {
    await withBrowser(async (browser) => {
      const result = await executeAutomation(browser, shopCheckout(fixture.url));
      assert.equal(result.success, true);
      assert.equal(result.failure, undefined);
    });
  } finally {
    await fixture.close();
  }
});

test("a target that appears after the locator timeout fails without a successful run", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("delayed-beyond.html") } });
  try {
    await withBrowser(async (browser) => {
      const result = await executeAutomation(browser, shopCheckout(fixture.url));
      assert.equal(result.success, false);
      assert.equal(result.failure?.stepId, "continue");
      assert.ok(
        result.failure?.error.type === "locator-not-found" ||
          result.failure?.error.type === "timeout" ||
          result.failure?.error.type === "element-not-visible",
      );
    });
  } finally {
    await fixture.close();
  }
});

test("normal reuse still executes an external-side-effect step", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("place-order.html") } });
  try {
    await withBrowser(async (browser) => {
      const result = await executeAutomation(browser, shopPlaceOrder(fixture.url));
      assert.equal(result.success, true);
      assert.equal(result.halted, undefined);
      assert.equal(result.automation.runStats?.successfulRuns, 1);
      assert.equal(
        result.events.some(
          (event) => event.type === "step.started" && event.stepId === "place-order",
        ),
        true,
      );
    });
  } finally {
    await fixture.close();
  }
});

test("repair validation can halt before an external-side-effect step", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("place-order.html") } });
  try {
    await withBrowser(async (browser) => {
      const result = await executeAutomation(browser, shopPlaceOrder(fixture.url), {
        haltBefore: (step) => step.safety === "external-side-effect",
      });
      assert.equal(result.success, true);
      assert.equal(result.halted, true);
      assert.equal(result.automation.runStats?.successfulRuns, undefined);
      assert.equal(
        result.events.some(
          (event) => event.type === "step.started" && event.stepId === "place-order",
        ),
        false,
      );
      assert.equal(
        result.events.some(
          (event) =>
            event.type === "run.finished" &&
            event.halted === true &&
            event.haltedStepId === "place-order",
        ),
        true,
      );
    });
  } finally {
    await fixture.close();
  }
});

test("HTTP 503 is infra and never looks like a locator repair", async () => {
  const fixture = await startFixtureServer({ "/": { status: 503, html: "unavailable" } });
  try {
    await withBrowser(async (browser) => {
      const result = await executeAutomation(browser, shopUnavailable(fixture.url));
      assert.equal(result.success, false);
      assert.equal(result.automation.runStats?.failedRuns, 1);
      assert.equal(result.automation.runStats?.successfulRuns, 0);
      assert.equal(result.failure?.error.type, "external-service-error");
      assert.equal(result.classification?.category, "infra");
      assert.equal(
        result.events.some((event) => event.type === "failure.classified"),
        true,
      );
    });
  } finally {
    await fixture.close();
  }
});

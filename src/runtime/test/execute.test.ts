import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import {
  automation,
  back,
  click,
  compile,
  drag,
  extractList,
  extractText,
  fill,
  hrefField,
  hover,
  inputRef,
  label,
  navigate,
  role,
  select,
  testId,
  textField,
  upload,
  urlField,
} from "../../core/index.js";
import { shopCheckout, shopPlaceOrder, shopUnavailable } from "../../fixtures/shop.js";
import { executeAutomation, executeStep, startFixtureServer, withBrowser } from "../index.js";

const shop = (name: string) => resolve("fixtures/shop", name);

test("hover reveals hover-driven controls", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(
      '<button id="trigger">Products</button><a id="item" hidden>Details</a><script>trigger.onmouseenter=()=>item.hidden=false</script>',
    );
    const result = await executeAutomation(
      { kind: "persistent", withPage: (run) => run(page), close: async () => {} },
      automation("hover-menu", () => [
        hover({
          id: "products",
          locator: role("button", { name: "Products" }),
          safety: "read-only",
        }),
      ]),
    );

    assert.equal(result.success, true, result.failure?.error.message);
    assert.equal(await page.locator("#item").isVisible(), true);
    await page.context().close();
  });
});

test("back returns to the previous history entry", async () => {
  const fixture = await startFixtureServer({
    "/first": { html: "<h1>First</h1>" },
    "/second": { html: "<h1>Second</h1>" },
  });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.goto(new URL("/first", fixture.url).href);
      await page.goto(new URL("/second", fixture.url).href);
      const result = await executeAutomation(
        { kind: "persistent", withPage: (run) => run(page), close: async () => {} },
        automation("go-back", () => [back({ id: "back", safety: "browser-local" })]),
      );

      assert.equal(result.success, true, result.failure?.error.message);
      assert.equal(await page.locator("h1").innerText(), "First");
      await page.context().close();
    });
  } finally {
    await fixture.close();
  }
});

test("back reports failure when no history entry was traversed", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent("<h1>Only page</h1>");

    const outcome = await executeStep(page, back({ id: "back", safety: "browser-local" }), 500);

    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.type, "navigation-failed");
      assert.equal(outcome.actionPerformed, undefined);
    }
    assert.equal(await page.locator("h1").innerText(), "Only page");
    await page.context().close();
  });
});

test("back accepts same-document history entries without a response", async () => {
  const fixture = await startFixtureServer({ "/page": { html: "<h1>Page</h1>" } });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.goto(new URL("/page#first", fixture.url).href);
      await page.evaluate(() => history.pushState({}, "", "#second"));
      const result = await executeAutomation(
        { kind: "persistent", withPage: (run) => run(page), close: async () => {} },
        automation("go-back-in-page", () => [back({ id: "back", safety: "browser-local" })]),
      );

      assert.equal(result.success, true, result.failure?.error.message);
      assert.equal(new URL(page.url()).hash, "#first");
      await page.context().close();
    });
  } finally {
    await fixture.close();
  }
});

test("back accepts same-URL history entries", async () => {
  const fixture = await startFixtureServer({ "/same": { html: "<h1>Initial</h1>" } });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.goto(new URL("/same", fixture.url).href);
      await page.evaluate(() => {
        history.replaceState({ page: "first" }, "", location.href);
        history.pushState({ page: "second" }, "", location.href);
        document.querySelector("h1")!.textContent = "Second";
        window.addEventListener("popstate", (event) => {
          document.querySelector("h1")!.textContent =
            (event.state as { page?: string } | null)?.page === "first" ? "First" : "Unknown";
        });
      });

      const result = await executeAutomation(
        { kind: "persistent", withPage: (run) => run(page), close: async () => {} },
        automation("go-back-same-url", () => [back({ id: "back", safety: "browser-local" })]),
      );

      assert.equal(result.success, true, result.failure?.error.message);
      assert.equal(await page.locator("h1").innerText(), "First");
      await page.context().close();
    });
  } finally {
    await fixture.close();
  }
});

test("drag moves a draggable item to a drop target", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="source" data-testid="source" draggable="true">Card</div><div id="target" data-testid="target">Column</div>
      <script>
        target.ondragover = event => event.preventDefault();
        target.ondrop = event => { event.preventDefault(); target.textContent = "Dropped"; };
      </script>
    `);
    const result = await executeAutomation(
      { kind: "persistent", withPage: (run) => run(page), close: async () => {} },
      automation("move-card", () => [
        drag({
          id: "move",
          source: testId("source"),
          target: testId("target"),
          safety: "browser-local",
        }),
      ]),
    );

    assert.equal(result.success, true, result.failure?.error.message);
    assert.equal(await page.locator("#target").innerText(), "Dropped");
    await page.context().close();
  });
});

test("click dispatches configured buttons, count, and modifiers", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <button>Target</button>
      <script>
        window.events = [];
        for (const type of ["click", "dblclick", "auxclick", "contextmenu"])
          document.querySelector("button").addEventListener(type, event =>
            window.events.push({ type, button: event.button, detail: event.detail, ctrlKey: event.ctrlKey }));
      </script>
    `);
    const target = role("button", { name: "Target" });
    const result = await executeAutomation(
      { kind: "persistent", withPage: (run) => run(page), close: async () => {} },
      automation("click-variants", () => [
        click({ id: "right", locator: target, button: "right", safety: "browser-local" }),
        click({ id: "middle", locator: target, button: "middle", safety: "browser-local" }),
        click({ id: "double", locator: target, clickCount: 2, safety: "browser-local" }),
        click({
          id: "modified",
          locator: target,
          modifiers: ["Control"],
          safety: "browser-local",
        }),
      ]),
    );

    assert.equal(result.success, true, result.failure?.error.message);
    const events = await page.evaluate(
      () =>
        (
          window as unknown as {
            events: Array<{ type: string; button: number; detail: number; ctrlKey: boolean }>;
          }
        ).events,
    );
    assert.ok(events.some((event) => event.type === "contextmenu" && event.button === 2));
    assert.ok(events.some((event) => event.type === "auxclick" && event.button === 1));
    assert.ok(events.some((event) => event.type === "dblclick" && event.detail === 2));
    assert.ok(events.some((event) => event.type === "click" && event.ctrlKey));
    await page.context().close();
  });
});

test("select accepts an input-backed list for a native multi-select", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <label for="regions">Regions</label><select id="regions" multiple><option value="eu">Europe</option><option value="na">North America</option><option value="apac">Asia Pacific</option></select>
    `);
    const result = await executeAutomation(
      { kind: "persistent", withPage: (run) => run(page), close: async () => {} },
      automation("choose-regions", () => [
        select({
          id: "regions",
          locator: label("Regions"),
          value: inputRef("regions"),
          safety: "browser-local",
        }),
      ]),
      { inputs: { regions: ["eu", "apac"] } },
    );

    assert.equal(result.success, true, result.failure?.error.message);
    assert.deepEqual(
      await page
        .locator("select")
        .evaluate((element) =>
          [...(element as HTMLSelectElement).selectedOptions].map((option) => option.value),
        ),
      ["eu", "apac"],
    );
    await page.context().close();
  });
});

test("upload assigns an input-backed file to a file control", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-upload-"));
  const path = join(directory, "report.txt");
  await writeFile(path, "hello upload");
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.setContent('<label for="file">Report</label><input id="file" type="file">');
      const result = await executeAutomation(
        { kind: "persistent", withPage: (run) => run(page), close: async () => {} },
        automation("upload-report", () => [
          upload({
            id: "report",
            locator: label("Report"),
            file: inputRef("path"),
            safety: "external-side-effect",
          }),
        ]),
        { inputs: { path } },
      );

      assert.equal(result.success, true, result.failure?.error.message);
      assert.equal(
        await page
          .locator("input")
          .evaluate(async (element) => (element as HTMLInputElement).files?.[0]?.text()),
        "hello upload",
      );
      await page.context().close();
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("click handles confirm and prompt dialogs with declared responses", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="confirm" data-testid="confirm">Confirm</button><button id="prompt" data-testid="prompt">Prompt</button>
      <output id="result"></output>
      <script>
        document.querySelector("#confirm").onclick = () => result.textContent = window.confirm("Continue?") ? "accepted" : "dismissed";
        document.querySelector("#prompt").onclick = () => result.textContent += ":" + window.prompt("Name?", "");
      </script>
    `);
    const run = await executeAutomation(
      { kind: "persistent", withPage: (operation) => operation(page), close: async () => {} },
      automation("dialogs", () => [
        click({
          id: "confirm",
          locator: testId("confirm"),
          dialog: { action: "accept" },
          safety: "browser-local",
        }),
        click({
          id: "prompt",
          locator: testId("prompt"),
          dialog: { action: "accept", promptText: inputRef("name") },
          safety: "browser-local",
        }),
      ]),
      { inputs: { name: "Ada" } },
    );

    assert.equal(run.success, true, run.failure?.error.message);
    assert.equal(await page.locator("#result").innerText(), "accepted:Ada");
    await page.context().close();
  });
});

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

test("upload failures after dispatch are uncertain, performed, and redact the file path", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent('<label for="file">Report</label><input id="file" type="file">');
    const sentinel = "/private/UPLOAD_SENTINEL_DO_NOT_EXPOSE.txt";
    const target = page.getByLabel("Report");
    page.getByLabel = (() => target) as typeof page.getByLabel;
    target.setInputFiles = async () => {
      throw new Error(`dispatch failed for ${sentinel}`);
    };

    const outcome = await executeStep(
      page,
      upload({
        id: "report",
        locator: label("Report"),
        file: inputRef("path"),
        safety: "external-side-effect",
      }),
      500,
      { path: sentinel },
    );

    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.type, "uncertain-outcome");
      assert.equal(outcome.actionPerformed, true);
      assert.doesNotMatch(outcome.message, /UPLOAD_SENTINEL_DO_NOT_EXPOSE/);
    }
    await page.context().close();
  });
});

test("upload completion failures after dispatch are uncertain, performed, and redact the file path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-upload-completion-"));
  const path = join(directory, "UPLOAD_COMPLETION_SENTINEL.txt");
  await writeFile(path, "uploaded");
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.setContent('<label for="file">Report</label><input id="file" type="file">');

      const outcome = await executeStep(
        page,
        upload({
          id: "report",
          locator: label("Report"),
          file: inputRef("path"),
          safety: "external-side-effect",
          completion: { kind: "count", locator: testId("never-created"), count: 1 },
          conditionTimeoutMs: 25,
        }),
        500,
        { path },
      );

      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.type, "uncertain-outcome");
        assert.equal(outcome.actionPerformed, true);
        assert.doesNotMatch(outcome.message, /UPLOAD_COMPLETION_SENTINEL/);
      }
      assert.equal(
        await page.locator("input").evaluate((node) => (node as HTMLInputElement).files?.length),
        1,
      );
      await page.context().close();
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed drag with an unmet completion condition must not be replayed", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<div data-testid="source" draggable="true">Source</div><div data-testid="target">Target</div>',
      );
      const outcome = await executeStep(
        page,
        drag({
          id: "drag",
          source: testId("source"),
          target: testId("target"),
          safety: "browser-local",
          completion: { kind: "count", locator: testId("missing"), count: 1 },
          conditionTimeoutMs: 50,
        }),
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.type, "uncertain-outcome");
        assert.equal(outcome.actionPerformed, true);
      }
    } finally {
      await page.context().close();
    }
  });
});

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { ElementReferences } from "../element-references.js";
import { collectOverview, toPageSnapshot } from "../../../runtime/overview.js";
import { startFixtureServer, withBrowser } from "../../../runtime/index.js";
import { resolveLocator } from "../../../runtime/locators.js";

test("unchanged DOM reuses references without rescanning, but replacement and reload invalidate them", async () => {
  const fixture = await startFixtureServer({ "/": { html: "<button>Apply</button>" } });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      const references = new ElementReferences();
      try {
        await page.goto(fixture.url);
        const snapshot = toPageSnapshot(await collectOverview(page));
        const scan = mock.method(page, "getByRole");
        const first = await references.capture(page, snapshot);
        assert.ok(scan.mock.callCount() > 0);
        scan.mock.resetCalls();
        const cached = await references.capture(page, snapshot);
        assert.deepEqual(cached, first);
        assert.equal(scan.mock.callCount(), 0);
        cached.elements.length = 0;
        assert.deepEqual(await references.capture(page, snapshot), first);
        await page.locator("button").evaluate((node) => node.replaceWith(node.cloneNode(true)));
        const replaced = await references.capture(page, snapshot);
        assert.ok(scan.mock.callCount() > 0);
        assert.notEqual(replaced.elements[0]!.elementRef, first.elements[0]!.elementRef);
        await assert.rejects(references.resolve(page, first.elements[0]!.elementRef), /Stale/);
        await page.reload();
        const reloaded = await references.capture(page, snapshot);
        assert.notEqual(reloaded.elements[0]!.elementRef, replaced.elements[0]!.elementRef);
        scan.mock.restore();
      } finally {
        await references.close();
        await page.close();
      }
    });
  } finally {
    await fixture.close();
  }
});

test("references distinguish headings from same-name links and update changed destinations", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: '<h3>Document</h3><a href="/one">Document</a><input type="checkbox" aria-label="Select" data-testid="select">',
    },
  });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      const references = new ElementReferences();
      try {
        await page.goto(fixture.url);
        const snapshot = toPageSnapshot(await collectOverview(page));
        const first = await references.capture(page, snapshot);
        const heading = first.elements.find((x) => x.role === "heading")!;
        const link = first.elements.find((x) => x.role === "link")!;
        assert.equal(heading.tag, "h3");
        assert.equal(heading.href, undefined);
        assert.equal(link.tag, "a");
        assert.equal(first.elements.find((x) => x.label === "Select")!.role, "checkbox");
        assert.equal(link.href, new URL("/one", fixture.url).href);
        await page.locator("a").evaluate((node) => node.setAttribute("href", "/two"));
        // Even the same supplied snapshot must not preserve old destination metadata.
        const second = await references.capture(page, snapshot);
        assert.equal(
          second.elements.find((x) => x.role === "link")!.href,
          new URL("/two", fixture.url).href,
        );
      } finally {
        await references.close();
        await page.close();
      }
    });
  } finally {
    await fixture.close();
  }
});

test("same-name controls get distinct references with host-compiled semantic scopes", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: "<fieldset><legend>Shipping</legend><button>Apply</button></fieldset><fieldset><legend>Billing</legend><button>Apply</button></fieldset>",
    },
  });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.goto(fixture.url);
      const references = new ElementReferences();
      const snapshot = toPageSnapshot(await collectOverview(page));
      const { elements } = await references.capture(page, snapshot);
      const shipping = elements.find(
        (item) => item.label === "Apply" && item.context === "Shipping",
      )!;
      const billing = elements.find(
        (item) => item.label === "Apply" && item.context === "Billing",
      )!;
      assert.ok(shipping);
      assert.ok(billing);
      assert.notEqual(shipping.elementRef, billing.elementRef);
      const locator = await references.resolve(page, billing.elementRef);
      assert.equal(locator.within?.kind, "container");
      assert.equal(JSON.stringify(locator).includes("nth-of-type"), false);
      await resolveLocator(page, locator).click();
      assert.deepEqual((await references.capture(page, snapshot)).elements, elements);
      await references.close();
      await page.close();
    });
  } finally {
    await fixture.close();
  }
});

test("replaced nodes cannot be clicked using an old reference, even at the same URL", async () => {
  const fixture = await startFixtureServer({ "/": { html: "<button>Apply</button>" } });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.goto(fixture.url);
      const references = new ElementReferences();
      const snapshot = toPageSnapshot(await collectOverview(page));
      const first = (await references.capture(page, snapshot)).elements.find(
        (item) => item.label === "Apply",
      )!;
      await page.locator("button").evaluate((node) => node.replaceWith(node.cloneNode(true)));
      await assert.rejects(references.resolve(page, first.elementRef), /Stale element reference/);
      const second = (await references.capture(page, snapshot)).elements.find(
        (item) => item.label === "Apply",
      )!;
      assert.notEqual(second.elementRef, first.elementRef);
      await references.resolve(page, second.elementRef);
      await page.goto(fixture.url);
      await assert.rejects(references.resolve(page, second.elementRef), /Stale element reference/);
      await references.close();
      await page.close();
    });
  } finally {
    await fixture.close();
  }
});

test("a mistaken reference is rejected against the intended label before acting", async () => {
  const fixture = await startFixtureServer({
    "/": { html: "<button>Green</button><button>Purple</button>" },
  });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      const references = new ElementReferences();
      try {
        await page.goto(fixture.url);
        const { elements } = await references.capture(
          page,
          toPageSnapshot(await collectOverview(page)),
        );
        const green = elements.find((item) => item.label === "Green")!;
        const purple = elements.find((item) => item.label === "Purple")!;
        assert.throws(
          () => references.assertLabel(green.elementRef, "Purple"),
          /No action was performed/,
        );
        references.assertLabel(purple.elementRef, "Purple");
      } finally {
        await references.close();
        await page.close();
      }
    });
  } finally {
    await fixture.close();
  }
});

test("binding a choice preserves its palette and accepts a different choice later", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: "<div><label>Fill</label><div><button>Purple</button><button>Green</button></div></div><div><label>Border</label><div><button>Purple</button><button>Green</button></div></div>",
    },
  });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      const references = new ElementReferences();
      try {
        await page.goto(fixture.url);
        const { elements } = await references.capture(
          page,
          toPageSnapshot(await collectOverview(page)),
        );
        const purple = elements.find((item) => item.label === "Purple" && item.context === "Fill")!;
        assert.ok(purple);
        await assert.rejects(
          references.bind(
            page,
            purple.elementRef,
            { kind: "input", key: "choice" },
            { choice: "Green" },
          ),
          /does not select the referenced element/,
        );
        const locator = await references.bind(
          page,
          purple.elementRef,
          { kind: "input", key: "choice" },
          { choice: "Purple" },
        );
        assert.equal(await resolveLocator(page, locator, { choice: "Purple" }).count(), 1);
        assert.equal(
          await resolveLocator(page, locator, { choice: "Green" }).evaluate(
            (node) => node.parentElement?.parentElement?.querySelector("label")?.textContent,
          ),
          "Fill",
        );
        await page.reload();
        assert.equal(await resolveLocator(page, locator, { choice: "Green" }).count(), 1);
      } finally {
        await references.close();
        await page.close();
      }
    });
  } finally {
    await fixture.close();
  }
});

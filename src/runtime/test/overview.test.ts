import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocator } from "../locators.js";
import { collectOverview, toPageSnapshot } from "../overview.js";
import { startFixtureServer, withBrowser } from "../index.js";

test("overview names match Playwright for split text, hidden content and labelled controls", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: `
    <button><span>Search docs</span><kbd style="display:none">Ctrl K</kbd><span> now</span></button>
    <span id="label">Find records</span><button aria-labelledby="label">Wrong text</button>
    <button><span>Read</span><span style="display:block">more</span></button>
    <a href="/general">API</a><a href="/specific">API</a>
  `,
    },
  });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.goto(fixture.url);
      const overview = await collectOverview(page);
      for (const control of overview.interactive.filter((control) => control.tag === "button")) {
        assert.equal(control.role, "button");
        assert.ok(control.name);
        assert.equal(
          await page.getByRole("button", { name: control.name, exact: true }).count(),
          1,
        );
      }
      assert.equal(overview.interactive[1]?.name, "Find records");
      for (const control of toPageSnapshot(overview)
        .regions.flatMap((region) => region.controls)
        .filter((control) => control.role === "button")) {
        assert.ok(control.locator);
        assert.equal(await resolveLocator(page, control.locator).count(), 1);
      }
      const links = toPageSnapshot(overview)
        .regions.flatMap((region) => region.controls)
        .filter((c) => c.role === "link");
      assert.deepEqual(
        links.map((c) => c.href),
        ["/general", "/specific"],
      );
      for (const link of links) {
        assert.ok(link.locator);
        assert.equal(await resolveLocator(page, link.locator).count(), 2);
      }
      await page.close();
    });
  } finally {
    await fixture.close();
  }
});

test("overview exposes actual landmark names and IDs rather than naming them after headings", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: `
    <header><a href="/">Home</a></header>
    <main id="page-content"><h1>Documentation title</h1><p>Instructions</p></main>
    <aside aria-labelledby="related-title"><h2 id="related-title">Related pages</h2></aside>
  `,
    },
  });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.goto(fixture.url);
      const overview = await collectOverview(page);
      assert.deepEqual(overview.landmarks, [
        { role: "banner", interactiveCount: 1 },
        { role: "main", id: "page-content", interactiveCount: 0 },
        { role: "complementary", name: "Related pages", interactiveCount: 0 },
      ]);
      for (const landmark of toPageSnapshot(overview).landmarks) {
        assert.equal(landmark.locator.strategy, "role");
        assert.equal(await resolveLocator(page, landmark.locator).count(), 1);
      }
      assert.equal(
        await page.getByRole("main", { name: "Documentation title", exact: true }).count(),
        0,
      );
      await page.close();
    });
  } finally {
    await fixture.close();
  }
});

test("heading locators distinguish duplicate names and IDs without depending on heading text", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(
      '<h2 id="duplicate">Create<span aria-hidden="true">#</span></h2><h2 id="duplicate">Create</h2><div role="heading" aria-level="5">Reference</div>',
    );
    const overview = await collectOverview(page);
    assert.equal(overview.headings.length, 3);
    for (const heading of overview.headings) {
      assert.ok(heading.locator);
      assert.equal(await resolveLocator(page, heading.locator).count(), 1);
    }
    assert.equal(overview.headings[2]?.level, 5);
    assert.notDeepEqual(overview.headings[0]?.locator, overview.headings[1]?.locator);
  });
});

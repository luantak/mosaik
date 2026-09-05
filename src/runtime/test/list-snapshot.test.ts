import assert from "node:assert/strict";
import { test } from "vitest";
import { executeStep } from "../execute.js";
import { startFixtureServer, withBrowser } from "../index.js";

test("row fields are read together without a count followed by live row indexing", async () => {
  const fixture = await startFixtureServer({
    "/": { html: '<a data-row href="/one">One</a><a data-row href="/two">Two</a>' },
  });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.goto(fixture.url);
      const original = page.locator.bind(page);
      page.locator = (...args) => {
        const locator = original(...args);
        const count = locator.count.bind(locator);
        locator.count = async () => {
          const value = await count();
          await page.evaluate(() => document.querySelectorAll("[data-row]")[1]?.remove());
          return value;
        };
        return locator;
      };
      const result = await executeStep(page, {
        id: "links",
        type: "extract-list",
        safety: "read-only",
        output: "links",
        locator: { strategy: "css", selector: "[data-row]" },
        fields: { title: { source: "text" }, href: { source: "url", name: "href" } },
      });
      assert.deepEqual(result, {
        ok: true,
        output: {
          key: "links",
          value: [
            { title: "One", href: new URL("/one", fixture.url).href },
            { title: "Two", href: new URL("/two", fixture.url).href },
          ],
        },
      });
    });
  } finally {
    await fixture.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { withBrowser } from "../browser.js";
import { locatorAlternatives } from "../locator-alternatives.js";
import { resolveLocator } from "../locators.js";

test("failed heading locators receive observed scoped alternatives without guessing names", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setContent(
      '<main><h2 id="create">Create <span aria-hidden="true">#</span>agent</h2><h2 id="other">Other</h2></main><aside><h2 id="outside">Create agent</h2></aside>',
    );
    const requested = {
      strategy: "role",
      role: "heading",
      name: "Create #agent",
      exact: true,
      within: { kind: "landmark", role: "main" },
    } as const;
    assert.equal(await resolveLocator(page, requested).count(), 0);
    const alternatives = await locatorAlternatives(page, requested);
    assert.equal(alternatives.length, 1);
    assert.equal(await resolveLocator(page, alternatives[0]!.locator).getAttribute("id"), "create");
    assert.deepEqual(alternatives[0]!.locator.within, requested.within);
    assert.equal(await resolveLocator(page, requested).count(), 0);
  });
});

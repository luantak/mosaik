import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { observeCondition, waitCondition } from "../conditions.js";
import { validateCondition } from "../../capabilities/contracts.js";
import { conditionsDisjoint } from "../../capabilities/implementations.js";
import type { Condition } from "../../core/types.js";

test("list readiness supports lower bounds without weakening unique-target checks", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<ul><li>One</li><li>Two</li></ul>");
    const locator = { strategy: "css" as const, selector: "li" };
    const ready: Condition = { kind: "count", locator, count: 1, comparison: "gte" };
    validateCondition(ready);
    await waitCondition(page, ready, {}, 0);
    assert.equal(await observeCondition(page, { kind: "visible", locator }, {}), false);
    assert.equal(await observeCondition(page, { kind: "count", locator, count: 1 }, {}), false);
    assert.equal(
      await observeCondition(page, { kind: "count", locator, count: 2, comparison: "lte" }, {}),
      true,
    );
    assert.equal(conditionsDisjoint(ready, { kind: "count", locator, count: 2 }), false);
    await page.setContent("<ul></ul>");
    assert.equal(await observeCondition(page, ready, {}), false);
    assert.equal(await observeCondition(page, { kind: "count", locator, count: 0 }, {}), true);
  } finally {
    await browser.close();
  }
});

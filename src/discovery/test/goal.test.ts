import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import { startFixtureServer, withBrowser } from "../../runtime/index.js";
import { goalCheck } from "../goal.js";
import { createDiscoveryTools } from "../tools.js";
import { DEFAULT_DISCOVERY_CONSTRAINTS } from "../types.js";

const shop = (name: string) => resolve("fixtures/shop", name);

test("goalCheck keeps reached and goalReached identical", () => {
  const reached = goalCheck(true, { type: "text", contains: "The Great Wave" });
  const missed = goalCheck(false, { type: "text", contains: "The Great Wave" }, "not visible");
  assert.equal(reached.reached, reached.goalReached);
  assert.equal(reached.reached, true);
  assert.equal(missed.reached, missed.goalReached);
  assert.equal(missed.reached, false);
});

test("checkGoal exposes both reached and goalReached as the same boolean", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("discovery-product.html") } });
  try {
    await withBrowser(async (browser) => {
      const { tools, close } = createDiscoveryTools(browser, {
        id: "mug-price",
        task: "Read the mug price.",
        startUrl: fixture.url,
        goal: { type: "text", contains: "$18.00" },
        constraints: DEFAULT_DISCOVERY_CONSTRAINTS,
      });
      try {
        await tools.exploreNavigate({ url: fixture.url });
        const check = await tools.checkGoal();
        assert.equal(check.reached, true);
        assert.equal(check.goalReached, true);
        assert.equal(check.reached, check.goalReached);
      } finally {
        await close();
      }
    });
  } finally {
    await fixture.close();
  }
});

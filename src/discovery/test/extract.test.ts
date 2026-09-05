import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { testId } from "../../core/index.js";
import { executeAutomation, startFixtureServer, withBrowser } from "../../runtime/index.js";
import { createDiscoveryTools } from "../tools.js";
import { DEFAULT_DISCOVERY_CONSTRAINTS } from "../types.js";

const shop = (name: string) => resolve("fixtures/shop", name);
const priceLocator = testId("price");

test("readText previews extract-text and later reuse returns the output", async () => {
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
        const preview = await tools.readText({ locator: priceLocator });
        assert.equal(preview.unique, true);
        assert.equal(preview.text, "$18.00");
        const ambiguous = await tools.readText({ locator: { strategy: "css", selector: "p" } });
        assert.equal(ambiguous.unique, false);
        assert.equal(ambiguous.text, undefined);
        assert.equal((await tools.getDraft()).automation.actions[0]?.steps.length, 0);

        await tools.addStep({
          step: { id: "open", type: "navigate", safety: "browser-local", url: fixture.url },
        });
        await tools.addStep({
          step: {
            id: "price",
            type: "extract-text",
            safety: "read-only",
            locator: priceLocator,
            output: "price",
          },
        });
        const proposal = await tools.finish({ status: "discovered" });
        assert.ok(proposal);
        assert.equal(proposal.verification.status, "unverified");
        assert.deepEqual(
          proposal.automation.actions[0]?.steps.map((step) => step.id),
          ["open", "price"],
        );

        const reuse = await executeAutomation(browser, proposal.automation);
        assert.equal(reuse.success, true);
        assert.equal(reuse.outputs.price, "$18.00");
        assert.equal(reuse.automation.verification?.status, "verified");
      } finally {
        await close();
      }
    });
  } finally {
    await fixture.close();
  }
});

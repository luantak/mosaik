import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import { form, label, role } from "../../core/index.js";
import { startFixtureServer, withBrowser } from "../../runtime/index.js";
import { createDiscoveryTools } from "../tools.js";
import { DEFAULT_DISCOVERY_CONSTRAINTS } from "../types.js";

const shop = (name: string) => resolve("fixtures/shop", name);

function checkoutRequest(startUrl: string) {
  return {
    id: "checkout",
    task: "Enter the provided email, select Germany, and continue.",
    startUrl,
    inputs: { email: "test@example.com" },
    goal: { type: "text" as const, contains: "Order received" },
    constraints: DEFAULT_DISCOVERY_CONSTRAINTS,
  };
}

test("exploration does not write draft steps", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("discovery-checkout.html") } });
  try {
    await withBrowser(async (browser) => {
      const { tools, close } = createDiscoveryTools(browser, checkoutRequest(fixture.url));
      try {
        await tools.exploreNavigate({ url: fixture.url });
        await tools.exploreFill({
          locator: label("Email"),
          value: "test@example.com",
        });
        const draft = await tools.getDraft();
        assert.equal(draft.automation.actions[0]?.steps.length, 0);
      } finally {
        await close();
      }
    });
  } finally {
    await fixture.close();
  }
});

test("discovers checkout into unverified four-step IR without an LLM", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("discovery-checkout.html") } });
  try {
    await withBrowser(async (browser) => {
      const request = checkoutRequest(fixture.url);
      const { tools, context, close } = createDiscoveryTools(browser, request);
      try {
        const opened = await tools.exploreNavigate({ url: fixture.url });
        assert.equal(opened.ok, true);
        const overview = await tools.getOverview();
        assert.equal(overview.forms[0]?.name, "Checkout");

        const emailLocator = label("Email", { within: form("Checkout") });
        const countryLocator = label("Country", { within: form("Checkout") });
        const continueLocator = role("button", { name: "Continue", within: form("Checkout") });

        assert.equal((await tools.testLocator({ locator: emailLocator })).unique, true);
        await tools.exploreFill({ locator: emailLocator, value: "test@example.com" });
        await tools.exploreSelect({ locator: countryLocator, value: "Germany" });
        const continued = await tools.exploreClick({ locator: continueLocator });
        assert.equal(continued.ok, true);

        const goal = await tools.checkGoal();
        assert.equal(goal.reached, true);

        await tools.addStep({
          step: { id: "open", type: "navigate", safety: "browser-local", url: fixture.url },
        });
        await tools.addStep({
          step: {
            id: "email",
            type: "fill",
            safety: "browser-local",
            locator: emailLocator,
            value: "test@example.com",
          },
        });
        await tools.addStep({
          step: {
            id: "country",
            type: "select",
            safety: "browser-local",
            locator: countryLocator,
            value: "DE",
          },
        });
        await tools.addStep({
          step: {
            id: "continue",
            type: "click",
            safety: "browser-local",
            locator: continueLocator,
          },
        });

        const proposal = await tools.finish({ status: "discovered" });
        assert.ok(proposal);
        assert.equal(proposal.outcome, "discovered");
        assert.equal(proposal.verification.status, "unverified");
        assert.equal(proposal.verification.discoveryGoalReached, true);
        assert.equal(proposal.automation.verification?.status, "unverified");

        const steps = proposal.automation.actions[0]?.steps ?? [];
        assert.deepEqual(
          steps.map((step) => step.id),
          ["open", "email", "country", "continue"],
        );
        assert.ok(steps[1]?.type === "fill");
        assert.deepEqual(steps[1].value, { kind: "input", key: "email" });
        assert.ok(steps[2]?.type === "select");
        assert.deepEqual(steps[2].value, { kind: "literal", value: "DE" });
        assert.ok(steps[1].locator.within?.kind === "form");
        assert.equal(steps[1].locator.within.name, "Checkout");

        assert.ok(context.explorationActions >= 4);
        assert.ok(context.explorationActions > steps.length || context.draftMutations === 4);
        assert.equal(
          context.log.events.some((event) => event.type === "exploration.action"),
          true,
        );
        assert.equal(
          context.log.events.some((event) => event.type === "draft.step.added"),
          true,
        );
        assert.equal(
          context.log.events.some((event) => event.type === "discovery.completed"),
          true,
        );
      } finally {
        await close();
      }
    });
  } finally {
    await fixture.close();
  }
});

test("exploration budget stops runaway clicking", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("discovery-checkout.html") } });
  try {
    await withBrowser(async (browser) => {
      const { tools, close } = createDiscoveryTools(browser, {
        ...checkoutRequest(fixture.url),
        constraints: { ...DEFAULT_DISCOVERY_CONSTRAINTS, maxExplorationActions: 1 },
      });
      try {
        await tools.exploreNavigate({ url: fixture.url });
        await assert.rejects(
          tools.exploreClick({ locator: role("button", { name: "Continue" }) }),
          /maxExplorationActions/,
        );
        const draft = await tools.getDraft();
        assert.equal(draft.automation.actions[0]?.steps.length, 0);
      } finally {
        await close();
      }
    });
  } finally {
    await fixture.close();
  }
});

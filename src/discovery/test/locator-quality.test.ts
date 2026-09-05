import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import { css, extractText } from "../../core/index.js";
import { startFixtureServer, withBrowser } from "../../runtime/index.js";
import { createDiscoveryTools } from "../tools.js";
import { DEFAULT_DISCOVERY_CONSTRAINTS } from "../types.js";

const r6 = (name: string) => resolve("fixtures/r6", name);
const shop = (name: string) => resolve("fixtures/shop", name);

function request(id: string, startUrl: string, task: string, contains: string) {
  return {
    id,
    task,
    startUrl,
    goal: { type: "text" as const, contains },
    constraints: DEFAULT_DISCOVERY_CONSTRAINTS,
  };
}

test("degraded fallback surfaces #run when the semantic layer has no name", async () => {
  const fixture = await startFixtureServer({ "/": { file: r6("empty-id.html") } });
  try {
    await withBrowser(async (browser) => {
      const { tools, close } = createDiscoveryTools(
        browser,
        request("empty-id", fixture.url, "Run the control.", "ready"),
      );
      try {
        await tools.exploreNavigate({ url: fixture.url });
        const overview = await tools.getOverview();
        assert.equal(
          overview.interactive.some((item) => item.id === "run" && (item.name?.length ?? 0) > 0),
          false,
        );
        assert.ok((overview.degraded ?? []).some((item) => item.id === "run"));
        const found = await tools.findCandidates();
        const run = found.candidates.find(
          (item) => item.locator.strategy === "css" && item.locator.selector === "#run",
        );
        assert.ok(run);
        assert.equal(run.source, "degraded-dom");
        const semanticFirst = found.candidates.find((item) => item.source === "semantic");
        if (semanticFirst !== undefined) {
          assert.ok(
            found.candidates.indexOf(semanticFirst) < found.candidates.indexOf(run),
            "semantic candidates stay ahead of degraded CSS",
          );
        }
      } finally {
        await close();
      }
    });
  } finally {
    await fixture.close();
  }
});

test("extraction candidates prefer the child span over the parent paragraph", async () => {
  const fixture = await startFixtureServer({ "/": { file: r6("parent-extract.html") } });
  try {
    await withBrowser(async (browser) => {
      const { tools, close } = createDiscoveryTools(
        browser,
        request("parent-extract", fixture.url, "Read the status.", "Open"),
      );
      try {
        await tools.exploreNavigate({ url: fixture.url });
        const found = await tools.findCandidates({ name: "Open", intent: "extract" });
        const leaf = found.candidates.find((item) => item.extractEvidence?.text === "Open");
        const parent = found.candidates.find((item) =>
          item.extractEvidence?.text.includes("Status: Open"),
        );
        assert.ok(leaf);
        assert.equal(leaf.extractEvidence?.granularity, "leaf");
        assert.ok(parent);
        assert.ok(found.candidates.indexOf(leaf) < found.candidates.indexOf(parent));

        await tools.addStep({
          step: { id: "open", type: "navigate", safety: "browser-local", url: fixture.url },
        });
        await tools.addStep({
          step: extractText({
            id: "status",
            locator: { strategy: "text", text: "Open", exact: true },
            output: "status",
            safety: "read-only",
          }),
        });
        const proposal = await tools.finish({ status: "discovered" });
        assert.ok(proposal);
      } finally {
        await close();
      }
    });
  } finally {
    await fixture.close();
  }
});

test("nested timezone extract prefers the specific text node", async () => {
  const fixture = await startFixtureServer({ "/": { file: r6("nested-extract.html") } });
  try {
    await withBrowser(async (browser) => {
      const { tools, close } = createDiscoveryTools(
        browser,
        request("nested-extract", fixture.url, "Read the timezone.", "Europe/Berlin"),
      );
      try {
        await tools.exploreNavigate({ url: fixture.url });
        const found = await tools.findCandidates({ name: "Europe/Berlin", intent: "extract" });
        assert.equal(found.candidates[0]?.extractEvidence?.text, "Europe/Berlin");
        const refined = await tools.refineTextTarget({
          locator: { strategy: "css", selector: "section" },
        });
        assert.ok(
          refined.candidates.some((item) => item.extractEvidence?.text === "Europe/Berlin"),
        );
      } finally {
        await close();
      }
    });
  } finally {
    await fixture.close();
  }
});

test("broad container extract remains representable when that is the output", async () => {
  const fixture = await startFixtureServer({ "/": { file: r6("broad-extract.html") } });
  try {
    await withBrowser(async (browser) => {
      const { tools, close } = createDiscoveryTools(
        browser,
        request("broad-extract", fixture.url, "Read the notice.", "Log retention"),
      );
      try {
        await tools.exploreNavigate({ url: fixture.url });
        const found = await tools.findCandidates({ intent: "extract", name: "Log retention" });
        assert.ok(
          found.candidates.some(
            (item) => item.locator.strategy === "css" && item.locator.selector === "#notice",
          ),
        );
        await tools.addStep({
          step: { id: "open", type: "navigate", safety: "browser-local", url: fixture.url },
        });
        await tools.addStep({
          step: extractText({
            id: "notice",
            locator: css("#notice"),
            output: "notice",
            safety: "read-only",
          }),
        });
        const proposal = await tools.finish({ status: "discovered" });
        assert.ok(proposal);
      } finally {
        await close();
      }
    });
  } finally {
    await fixture.close();
  }
});

test("semantic checkout candidates stay preferred over degraded CSS", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("discovery-checkout.html") } });
  try {
    await withBrowser(async (browser) => {
      const { tools, close } = createDiscoveryTools(browser, {
        id: "checkout",
        task: "Continue checkout.",
        startUrl: fixture.url,
        goal: { type: "text", contains: "Order received" },
        constraints: DEFAULT_DISCOVERY_CONSTRAINTS,
      });
      try {
        await tools.exploreNavigate({ url: fixture.url });
        const found = await tools.findCandidates({ role: "button", name: "Continue" });
        const continueBtn = found.candidates.find(
          (item) => item.locator.strategy === "role" && item.locator.name === "Continue",
        );
        assert.ok(continueBtn);
        assert.ok(continueBtn.source === "semantic" || continueBtn.source === "scoped-semantic");
        const firstDegraded = found.candidates.find((item) => item.source === "degraded-dom");
        if (firstDegraded !== undefined) {
          assert.ok(
            found.candidates.indexOf(continueBtn) < found.candidates.indexOf(firstDegraded),
          );
        }
      } finally {
        await close();
      }
    });
  } finally {
    await fixture.close();
  }
});

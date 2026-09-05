import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  collectDegradedNodes,
  collectTextTargets,
  isConservativeCss,
  isEligibleDegraded,
  refineTextTargets,
  type DegradedNodeRaw,
} from "../degraded.js";
import { startFixtureServer, withBrowser, withIsolatedContext } from "../index.js";

const r6 = (name: string) => resolve("fixtures/r6", name);
const holdout = (name: string) => resolve("fixtures/holdout", name);

function raw(overrides: Partial<DegradedNodeRaw> = {}): DegradedNodeRaw {
  return {
    tag: "div",
    attributes: {},
    boxVisible: false,
    listens: false,
    pointer: false,
    focusable: false,
    editable: false,
    stateful: false,
    hasTestId: false,
    semanticIdentity: false,
    adjacentToInteractive: false,
    nearbyText: [],
    ...overrides,
  };
}

test("conservative CSS accepts stable identities only", () => {
  assert.equal(isConservativeCss("#run"), true);
  assert.equal(isConservativeCss('[data-testid="price"]'), true);
  assert.equal(isConservativeCss('[name="email"]'), true);
  assert.equal(isConservativeCss('[type="email"][name="email"]'), true);
  assert.equal(isConservativeCss("div:nth-child(7) > span:nth-child(2)"), false);
  assert.equal(isConservativeCss("main > div"), false);
  assert.equal(isConservativeCss(".go"), false);
});

test("eligibility requires interaction or state evidence, not a bare id", () => {
  assert.equal(isEligibleDegraded(raw({ id: "deco-1", boxVisible: true })), false);
  assert.equal(isEligibleDegraded(raw({ id: "run", listens: true })), true);
  assert.equal(isEligibleDegraded(raw({ id: "field", focusable: true })), true);
  assert.equal(
    isEligibleDegraded(raw({ id: "note", semanticIdentity: true, listens: true })),
    false,
  );
  assert.equal(
    isEligibleDegraded(raw({ id: "stat", tag: "div", adjacentToInteractive: true })),
    true,
  );
});

test("empty-id clickable control is surfaced without semantic identity", async () => {
  const fixture = await startFixtureServer({ "/": { file: r6("empty-id.html") } });
  try {
    await withBrowser(async (browser) => {
      await withIsolatedContext(browser, async (page) => {
        await page.goto(fixture.url);
        const nodes = await collectDegradedNodes(page);
        const run = nodes.find((node) => node.id === "run");
        assert.ok(run);
        assert.equal(run.signals.clickable || run.signals.focusable, true);
      });
    });
  } finally {
    await fixture.close();
  }
});

test("state companion #stat is eligible and decorative ids are not dumped", async () => {
  const fixture = await startFixtureServer({
    "/state": { file: r6("stateful.html") },
    "/deco": { file: r6("decorative.html") },
    "/widget": { file: holdout("widget.html") },
  });
  try {
    await withBrowser(async (browser) => {
      await withIsolatedContext(browser, async (page) => {
        await page.goto(`${fixture.url}state`);
        const stateful = await collectDegradedNodes(page);
        assert.ok(stateful.some((node) => node.id === "run"));
        assert.ok(stateful.some((node) => node.id === "stat"));

        await page.click("#run");
        const after = await collectTextTargets(page, "41");
        assert.ok(
          after.some(
            (item) => item.locator.strategy === "css" && item.locator.selector === "#stat",
          ),
        );

        await page.goto(`${fixture.url}deco`);
        const deco = await collectDegradedNodes(page);
        assert.ok(deco.some((node) => node.id === "run"));
        assert.equal(deco.filter((node) => node.id?.startsWith("deco-")).length, 0);

        await page.goto(`${fixture.url}widget`);
        const widget = await collectDegradedNodes(page);
        assert.ok(widget.some((node) => node.id === "run" && node.signals.clickable));
        assert.ok(widget.some((node) => node.id === "stat"));
      });
    });
  } finally {
    await fixture.close();
  }
});

test("text targets prefer the smallest meaningful node and still keep the container", async () => {
  const fixture = await startFixtureServer({
    "/parent": { file: r6("parent-extract.html") },
    "/nested": { file: r6("nested-extract.html") },
    "/broad": { file: r6("broad-extract.html") },
  });
  try {
    await withBrowser(async (browser) => {
      await withIsolatedContext(browser, async (page) => {
        await page.goto(`${fixture.url}parent`);
        const parent = await collectTextTargets(page, "Open");
        assert.equal(parent[0]?.evidence.text, "Open");
        assert.equal(parent[0]?.evidence.granularity, "leaf");
        assert.ok(parent.some((item) => item.evidence.text.includes("Status: Open")));

        const refined = await refineTextTargets(page, { strategy: "css", selector: "p" });
        assert.ok(
          refined.some(
            (item) => item.evidence.text === "Open" && item.evidence.granularity === "leaf",
          ),
        );

        await page.goto(`${fixture.url}nested`);
        const nested = await collectTextTargets(page, "Europe/Berlin");
        assert.equal(nested[0]?.evidence.text, "Europe/Berlin");

        await page.goto(`${fixture.url}broad`);
        const broad = await collectTextTargets(page, "Europe/Berlin");
        assert.ok(
          broad.some(
            (item) => item.locator.strategy === "css" && item.locator.selector === "#notice",
          ),
        );
        assert.ok(broad.some((item) => item.evidence.text.includes("Log retention")));
      });
    });
  } finally {
    await fixture.close();
  }
});

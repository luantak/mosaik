import assert from "node:assert/strict";
import { test } from "vitest";
import { css, label, role, testId } from "../../core/index.js";
import { countLocatorProvenance, inferFromShape } from "../provenance.js";

test("locator provenance is inferred from strategy, not fixture names", () => {
  assert.equal(inferFromShape(role("button", { name: "Continue" })), "semantic");
  assert.equal(
    inferFromShape(label("Email", { within: { kind: "form", name: "Checkout" } })),
    "scoped-semantic",
  );
  assert.equal(inferFromShape(testId("price")), "test-id");
  assert.equal(inferFromShape(css("#run")), "degraded-dom-css");
  assert.equal(inferFromShape(css("div:nth-child(7) > span")), "manual-css");
});

test("provenance counts stay separated", () => {
  const counts = countLocatorProvenance([
    {
      id: "a",
      type: "click",
      safety: "browser-local",
      locator: role("button", { name: "Continue" }),
    },
    {
      id: "b",
      type: "click",
      safety: "browser-local",
      locator: css("#run"),
    },
  ]);
  assert.equal(counts.semantic, 1);
  assert.equal(counts.degradedCss, 1);
  assert.equal(counts.manualCss, 0);
});

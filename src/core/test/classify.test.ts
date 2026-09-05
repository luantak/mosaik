import assert from "node:assert/strict";
import { test } from "vitest";
import { classify } from "../classify.js";
import type { AutomationFailure } from "../types.js";

function failure(
  overrides: Partial<AutomationFailure> & Pick<AutomationFailure, "error">,
): AutomationFailure {
  return {
    runId: "run-1",
    automationId: "checkout",
    actionId: "checkout/main",
    stepId: "continue",
    step: {
      id: "continue",
      type: "click",
      safety: "browser-local",
      locator: { strategy: "role", role: "button", name: "Continue" },
    },
    page: { url: "http://127.0.0.1/" },
    artifacts: {},
    ...overrides,
  };
}

test("locator misses and ambiguity are repairable", () => {
  assert.equal(
    classify(failure({ error: { type: "locator-not-found", message: "missing" } })).category,
    "repairable-browser",
  );
  assert.equal(
    classify(failure({ error: { type: "locator-ambiguous", message: "two" } })).category,
    "repairable-browser",
  );
});

test("timeout without drift stays unknown", () => {
  const result = classify(
    failure({
      error: { type: "timeout", message: "Timeout 1500ms" },
      evidence: { matchCount: 1 },
    }),
  );
  assert.equal(result.category, "unknown");
});

test("timeout with similar names is repairable", () => {
  const result = classify(
    failure({
      error: { type: "timeout", message: "Timeout 1500ms" },
      evidence: { matchCount: 0, similarNames: ["Proceed"] },
    }),
  );
  assert.equal(result.category, "repairable-browser");
});

test("HTTP 503 is infra and not an agent case", () => {
  const result = classify(
    failure({
      error: { type: "external-service-error", message: "HTTP 503" },
      evidence: { httpStatus: 503 },
    }),
  );
  assert.equal(result.category, "infra");
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { parseTerminalDiscovery } from "../result.js";

test("terminal discovery requires unverified goal-reached automation", () => {
  const parsed = parseTerminalDiscovery({
    status: "discovered",
    goalReached: true,
    automation: { id: "checkout", version: 1, actions: [] },
    verification: { status: "unverified", discoveryGoalReached: true },
  });
  assert.equal(parsed?.status, "discovered");
});

test("verified or incomplete terminals are rejected", () => {
  assert.equal(
    parseTerminalDiscovery({
      status: "discovered",
      goalReached: true,
      automation: { id: "checkout", version: 1, actions: [] },
      verification: { status: "verified", discoveryGoalReached: true },
    }),
    undefined,
  );
  assert.deepEqual(parseTerminalDiscovery({ status: "refused", reason: "ambiguous" }), {
    status: "refused",
    reason: "ambiguous",
  });
});

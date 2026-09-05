import assert from "node:assert/strict";
import { test } from "vitest";
import { mayValidateStepLive, repairPolicyFor } from "../policy.js";

test("repair policy follows the safety field, not the step type", () => {
  assert.deepEqual(repairPolicyFor("read-only"), {
    autonomy: "autonomous",
    mayValidateLive: true,
  });
  assert.deepEqual(repairPolicyFor("browser-local"), {
    autonomy: "autonomous-validated",
    mayValidateLive: true,
  });
  assert.deepEqual(repairPolicyFor("external-side-effect"), {
    autonomy: "propose-only",
    mayValidateLive: false,
  });
});

test("the same click primitive can be read-only or external", () => {
  assert.equal(
    mayValidateStepLive({
      id: "open-details",
      type: "click",
      safety: "read-only",
      locator: { strategy: "role", role: "button", name: "Details" },
    }),
    true,
  );
  assert.equal(
    mayValidateStepLive({
      id: "place-order",
      type: "click",
      safety: "external-side-effect",
      locator: { strategy: "role", role: "button", name: "Place order" },
    }),
    false,
  );
});

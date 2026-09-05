import assert from "node:assert/strict";
import test from "node:test";
import {
  isAcceptableValidatedRepair,
  parseTerminalRepairResult,
  type ValidatedRepairResult,
} from "../repair-result.js";
import type { Step } from "../types.js";

const clickContinue: Step = {
  id: "continue",
  type: "click",
  safety: "browser-local",
  locator: { strategy: "role", role: "button", name: "Continue" },
};

const repairedProceed: ValidatedRepairResult = {
  status: "repaired",
  candidateId: "cand-1",
  patches: [
    {
      type: "replace-locator",
      stepId: "continue",
      locator: { strategy: "role", role: "button", name: "Proceed" },
    },
  ],
  validation: { step: { success: true }, action: { success: true } },
  evidence: { candidateTested: true, uniqueMatch: true, visible: true, enabled: true },
  canonicalIrModified: false,
};

test("complete validated repair parses", () => {
  const parsed = parseTerminalRepairResult(repairedProceed);
  assert.equal(parsed?.status, "repaired");
  assert.equal(
    parsed?.status === "repaired" && isAcceptableValidatedRepair(clickContinue, parsed),
    true,
  );
});

test("filling a button is not an acceptable fill repair", () => {
  const fillEmail: Step = {
    id: "email",
    type: "fill",
    safety: "browser-local",
    locator: { strategy: "label", label: "Email" },
    value: "a@b.c",
  };
  const parsed = parseTerminalRepairResult({
    ...repairedProceed,
    patches: [
      {
        type: "replace-locator",
        stepId: "email",
        locator: { strategy: "role", role: "button", name: "Proceed" },
      },
    ],
  });
  assert.equal(
    parsed?.status === "repaired" && isAcceptableValidatedRepair(fillEmail, parsed),
    false,
  );
});

test("clicking a textbox is not an acceptable click repair", () => {
  const parsed = parseTerminalRepairResult({
    ...repairedProceed,
    patches: [
      {
        type: "replace-locator",
        stepId: "continue",
        locator: { strategy: "role", role: "textbox", name: "Email" },
      },
    ],
  });
  assert.equal(parsed?.status, "repaired");
  assert.equal(
    parsed?.status === "repaired" && isAcceptableValidatedRepair(clickContinue, parsed),
    false,
  );
});

test("incomplete results are rejected", () => {
  assert.equal(
    parseTerminalRepairResult({ success: true, validated: true, locator: { strategy: "role" } }),
    undefined,
  );
  assert.equal(parseTerminalRepairResult({ status: "repaired", candidateId: "x" }), undefined);
  assert.equal(
    parseTerminalRepairResult({
      ...repairedProceed,
      validation: { step: { success: false } },
    }),
    undefined,
  );
});

test("a scope-changing patch is not an acceptable repair", () => {
  const scopedEmail: Step = {
    id: "email",
    type: "fill",
    safety: "browser-local",
    locator: { strategy: "label", label: "Email", within: { kind: "form", name: "Checkout" } },
    value: "a@b.c",
  };
  const parsed = parseTerminalRepairResult({
    ...repairedProceed,
    patches: [
      {
        type: "replace-locator",
        stepId: "email",
        locator: {
          strategy: "role",
          role: "textbox",
          name: "E-mail",
          within: { kind: "form", name: "Newsletter" },
        },
      },
    ],
  });
  assert.equal(
    parsed?.status === "repaired" && isAcceptableValidatedRepair(scopedEmail, parsed),
    false,
  );
});

test("no-repair is terminal but not a proposal", () => {
  const parsed = parseTerminalRepairResult({ status: "no-repair", reason: "No unique button" });
  assert.deepEqual(parsed, { status: "no-repair", reason: "No unique button" });
});

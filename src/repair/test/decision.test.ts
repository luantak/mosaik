import assert from "node:assert/strict";
import test from "node:test";
import type { Step } from "../../core/index.js";
import type { LocatorCandidate } from "../candidates.js";
import { decideCandidates } from "../decision.js";

const clickContinue: Step = {
  id: "continue",
  type: "click",
  safety: "browser-local",
  locator: { strategy: "role", role: "button", name: "Continue" },
};

const fillEmail: Step = {
  id: "email",
  type: "fill",
  safety: "browser-local",
  locator: { strategy: "label", label: "Email" },
  value: "a@b.c",
};

function candidate(
  name: string,
  role: string,
  evidence: Partial<LocatorCandidate["evidence"]> = {},
): LocatorCandidate {
  return {
    locator: { strategy: "role", role, name, exact: true },
    evidence: {
      roleCompatible: true,
      exactNameMatch: false,
      exactLabelMatch: false,
      nameSimilarity: 0,
      labelSimilarity: 0,
      unique: true,
      sameRole: role === "button",
      sameStrategy: true,
      matchCount: 1,
      visible: true,
      enabled: true,
      structuralContextMatch: false,
      scopeCompatible: true,
      ...evidence,
    },
  };
}

test("two executable but distinct buttons stay ambiguous", () => {
  const decision = decideCandidates(clickContinue, [
    candidate("Proceed", "button"),
    candidate("Finish order", "button"),
  ]);
  assert.equal(decision.status, "ambiguous");
});

test("structuralContextMatch is not required for eligibility", () => {
  const proceed = candidate("Proceed", "button", { structuralContextMatch: false });
  const decision = decideCandidates(clickContinue, [proceed]);
  assert.equal(decision.status, "eligible");
  assert.equal(
    decision.status === "eligible" && decision.candidate.evidence.structuralContextMatch,
    false,
  );
});

test("a single unique replacement stays eligible", () => {
  const proceed = candidate("Proceed", "button");
  const decision = decideCandidates(clickContinue, [
    proceed,
    candidate("Email", "textbox", { roleCompatible: false }),
  ]);
  assert.equal(decision.status, "eligible");
  assert.equal(
    decision.status === "eligible" &&
      decision.candidate.locator.strategy === "role" &&
      decision.candidate.locator.name === "Proceed",
    true,
  );
});

test("unrelated fill controls are not plausible", () => {
  const email = candidate("E-mail", "textbox", { nameSimilarity: 0.67, exactNameMatch: false });
  const ticket = candidate("Ticket", "textbox", { nameSimilarity: 0 });
  const decision = decideCandidates(fillEmail, [email, ticket]);
  assert.equal(decision.status, "eligible");
  assert.equal(
    decision.status === "eligible" &&
      decision.candidate.locator.strategy === "role" &&
      decision.candidate.locator.name === "E-mail",
    true,
  );
});

test("out-of-scope exact matches are not plausible", () => {
  const decision = decideCandidates(
    {
      ...fillEmail,
      locator: { strategy: "label", label: "Email", within: { kind: "form", name: "Checkout" } },
    },
    [
      candidate("Email", "textbox", {
        exactNameMatch: true,
        exactLabelMatch: true,
        scopeCompatible: false,
        formName: "Newsletter",
      }),
      candidate("E-mail", "textbox", {
        nameSimilarity: 0.67,
        scopeCompatible: true,
        formName: "Checkout",
      }),
    ],
  );
  assert.equal(decision.status, "eligible");
  assert.equal(
    decision.status === "eligible" &&
      decision.candidate.locator.strategy === "role" &&
      decision.candidate.locator.name === "E-mail",
    true,
  );
});

test("two exact emails in different forms stay ambiguous", () => {
  const decision = decideCandidates(fillEmail, [
    candidate("Email", "textbox", {
      exactNameMatch: true,
      exactLabelMatch: true,
      formName: "Billing",
    }),
    candidate("Email", "textbox", {
      exactNameMatch: true,
      exactLabelMatch: true,
      formName: "Shipping",
    }),
  ]);
  assert.equal(decision.status, "ambiguous");
});

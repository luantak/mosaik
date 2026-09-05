import assert from "node:assert/strict";
import { test } from "vitest";
import { form, inputRef, label, literalValue, role } from "../../core/index.js";
import { addDraftStep, emptyDraft, removeDraftStep, updateDraftStep } from "../draft.js";
import { DEFAULT_DISCOVERY_CONSTRAINTS } from "../types.js";

const request = {
  id: "checkout",
  task: "Enter the provided email, select Germany, and continue.",
  constraints: DEFAULT_DISCOVERY_CONSTRAINTS,
};

test("draft starts empty and compile is deferred until a step exists", () => {
  const draft = emptyDraft(request);
  assert.equal(draft.actions[0]?.steps.length, 0);
  assert.equal(draft.verification?.status, "unverified");
});

test("addStep records IR without requiring exploration history", () => {
  const draft = addDraftStep(
    emptyDraft(request),
    {
      id: "email",
      type: "fill",
      safety: "browser-local",
      locator: label("Email", { within: form("Checkout") }),
      value: inputRef("email"),
    },
    request.constraints,
  );
  const step = draft.actions[0]?.steps[0];
  assert.ok(step?.type === "fill");
  assert.deepEqual(step.value, { kind: "input", key: "email" });
});

test("update and remove keep only the intended steps", () => {
  const withEmail = addDraftStep(
    emptyDraft(request),
    {
      id: "email",
      type: "fill",
      safety: "browser-local",
      locator: label("Email"),
      value: literalValue("wrong@example.com"),
    },
    request.constraints,
  );
  const corrected = updateDraftStep(
    withEmail,
    {
      id: "email",
      type: "fill",
      safety: "browser-local",
      locator: label("Email", { within: form("Checkout") }),
      value: inputRef("email"),
    },
    request.constraints,
  );
  const extra = addDraftStep(
    corrected,
    {
      id: "noise",
      type: "click",
      safety: "browser-local",
      locator: role("button", { name: "Newsletter" }),
    },
    request.constraints,
  );
  const cleaned = removeDraftStep(extra, "noise");
  assert.equal(cleaned.actions[0]?.steps.length, 1);
  const step = cleaned.actions[0]?.steps[0];
  assert.ok(step?.type === "fill");
  assert.deepEqual(step.value, { kind: "input", key: "email" });
});

test("budgets and unsafe steps are rejected", () => {
  assert.throws(
    () =>
      addDraftStep(
        emptyDraft(request),
        {
          id: "order",
          type: "click",
          safety: "external-side-effect",
          locator: role("button", { name: "Place order" }),
        },
        request.constraints,
      ),
    /external-side-effect/,
  );
  const tight = { ...request.constraints, maxSteps: 1 };
  const one = addDraftStep(
    emptyDraft(request),
    {
      id: "email",
      type: "fill",
      safety: "browser-local",
      locator: label("Email"),
      value: inputRef("email"),
    },
    tight,
  );
  assert.throws(
    () =>
      addDraftStep(
        one,
        {
          id: "country",
          type: "select",
          safety: "browser-local",
          locator: label("Country"),
          value: literalValue("DE"),
        },
        tight,
      ),
    /maxSteps/,
  );
});

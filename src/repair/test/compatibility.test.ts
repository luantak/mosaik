import assert from "node:assert/strict";
import test from "node:test";
import type { Step } from "../../core/index.js";
import {
  assessExactNameIdentity,
  assessRoleCompatibility,
  assessScopeCompatibility,
} from "../compatibility.js";

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

const selectCountry: Step = {
  id: "country",
  type: "select",
  safety: "browser-local",
  locator: { strategy: "label", label: "Country" },
  value: "DE",
};

test("incompatible roles are rejected with an explicit reason", () => {
  assert.deepEqual(assessRoleCompatibility(clickContinue, "textbox"), {
    compatible: false,
    reasons: ["role-mismatch: button -> textbox"],
  });
  assert.deepEqual(assessRoleCompatibility(fillEmail, "button"), {
    compatible: false,
    reasons: ["role-mismatch: textbox -> button"],
  });
  assert.deepEqual(assessRoleCompatibility(selectCountry, "textbox"), {
    compatible: false,
    reasons: ["role-mismatch: combobox -> textbox"],
  });
});

test("same-role and equivalent click roles stay eligible", () => {
  assert.equal(assessRoleCompatibility(clickContinue, "button").compatible, true);
  assert.equal(assessRoleCompatibility(clickContinue, "link").compatible, true);
  assert.equal(assessRoleCompatibility(fillEmail, "textbox").compatible, true);
  assert.equal(assessRoleCompatibility(fillEmail, "searchbox").compatible, true);
  assert.equal(assessRoleCompatibility(selectCountry, "combobox").compatible, true);
});

test("exact identity rejects substring-only names", () => {
  assert.deepEqual(
    assessExactNameIdentity(
      { strategy: "role", role: "button", name: "Continue" },
      { strategy: "role", role: "button", name: "Continue setup" },
    ),
    { compatible: false, reasons: ["exact-name-mismatch: Continue != Continue setup"] },
  );
  assert.deepEqual(
    assessExactNameIdentity(
      { strategy: "label", label: "Email" },
      { strategy: "label", label: "Email address" },
    ),
    { compatible: false, reasons: ["exact-name-mismatch: Email != Email address"] },
  );
  assert.equal(
    assessExactNameIdentity(
      { strategy: "role", role: "button", name: "Continue" },
      { strategy: "role", role: "button", name: "Proceed" },
    ).compatible,
    true,
  );
});

test("scope changes and missing scope are rejected", () => {
  const original = {
    strategy: "label" as const,
    label: "Email",
    within: { kind: "form" as const, name: "Checkout" },
  };
  assert.deepEqual(
    assessScopeCompatibility(original, { within: { kind: "form", name: "Newsletter" } }),
    { compatible: false, reasons: ['scope-change: form "Checkout" -> form "Newsletter"'] },
  );
  assert.deepEqual(assessScopeCompatibility(original, {}), {
    compatible: false,
    reasons: ['scope-missing: form "Checkout"'],
  });
  assert.equal(
    assessScopeCompatibility(original, { within: { kind: "form", name: "Checkout" } }).compatible,
    true,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { bindLocatorScope } from "../scope.js";

test("unscoped originals do not gain an invented container", () => {
  const bound = bindLocatorScope(
    { strategy: "label", label: "Email" },
    {
      strategy: "role",
      role: "textbox",
      name: "E-mail",
      within: { kind: "landmark", role: "main" },
    },
  );
  assert.equal("rejected" in bound, false);
  if ("rejected" in bound) return;
  assert.equal(bound.locator.within, undefined);
  assert.equal(bound.locator.strategy === "role" && bound.locator.name === "E-mail", true);
});

test("scoped originals keep their form and reject a different one", () => {
  const original = {
    strategy: "label" as const,
    label: "Email",
    within: { kind: "form" as const, name: "Checkout" },
  };
  const preserved = bindLocatorScope(original, { strategy: "label", label: "E-mail" });
  assert.equal("rejected" in preserved, false);
  if ("rejected" in preserved) return;
  assert.deepEqual(preserved.locator.within, { kind: "form", name: "Checkout" });
  const rejected = bindLocatorScope(original, {
    strategy: "label",
    label: "E-mail",
    within: { kind: "form", name: "Newsletter" },
  });
  assert.equal("rejected" in rejected, true);
});

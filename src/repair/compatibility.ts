import type { LocatorDefinition, LocatorScope, Step } from "../core/index.js";
import { hasLocator, scopeLabel, scopesEqual } from "../core/index.js";
import { isFuzzySubstring, namesEqual } from "./similarity.js";

export interface CompatibilityResult {
  compatible: boolean;
  reasons: string[];
}

const CLICK_ROLES = new Set(["button", "link"]);
const FILL_ROLES = new Set(["textbox", "searchbox"]);
const SELECT_ROLES = new Set(["combobox", "listbox"]);

export function rolesForStep(step: Step): Set<string> | undefined {
  switch (step.type) {
    case "click":
      return CLICK_ROLES;
    case "fill":
      return FILL_ROLES;
    case "select":
      return SELECT_ROLES;
    default:
      return undefined;
  }
}

export function locatorDeclaredRole(locator: LocatorDefinition): string | undefined {
  return locator.strategy === "role" ? locator.role : undefined;
}

export function locatorName(locator: LocatorDefinition): string | undefined {
  switch (locator.strategy) {
    case "role":
      return locator.name;
    case "text":
      return locator.text;
    case "label":
      return locator.label;
    case "test-id":
      return locator.testId;
    case "css":
      return undefined;
  }
}

export function impliedStepRole(step: Step): string | undefined {
  if (hasLocator(step) && step.locator.strategy === "role") return step.locator.role;
  if (step.type === "click") return "button";
  if (step.type === "fill") return "textbox";
  if (step.type === "select") return "combobox";
  return undefined;
}

export function assessRoleCompatibility(
  step: Step,
  candidateRole: string | undefined,
): CompatibilityResult {
  const expected = rolesForStep(step);
  if (expected === undefined || candidateRole === undefined) {
    return { compatible: true, reasons: [] };
  }
  if (expected.has(candidateRole)) return { compatible: true, reasons: [] };
  const from = impliedStepRole(step) ?? [...expected][0] ?? "unknown";
  return {
    compatible: false,
    reasons: [`role-mismatch: ${from} -> ${candidateRole}`],
  };
}

export function assessExactNameIdentity(
  failed: LocatorDefinition,
  proposed: LocatorDefinition,
): CompatibilityResult {
  const failedName = locatorName(failed);
  const proposedName = locatorName(proposed);
  if (failedName === undefined || proposedName === undefined) {
    return { compatible: true, reasons: [] };
  }
  if (namesEqual(failedName, proposedName)) return { compatible: true, reasons: [] };
  if (isFuzzySubstring(failedName, proposedName)) {
    return {
      compatible: false,
      reasons: [`exact-name-mismatch: ${failedName} != ${proposedName}`],
    };
  }
  return { compatible: true, reasons: [] };
}

export function assessScopeCompatibility(
  original: LocatorDefinition,
  proposed: { within?: LocatorScope },
): CompatibilityResult {
  if (original.within === undefined) return { compatible: true, reasons: [] };
  if (proposed.within === undefined) {
    return { compatible: false, reasons: [`scope-missing: ${scopeLabel(original.within)}`] };
  }
  if (scopesEqual(original.within, proposed.within)) return { compatible: true, reasons: [] };
  return {
    compatible: false,
    reasons: [`scope-change: ${scopeLabel(original.within)} -> ${scopeLabel(proposed.within)}`],
  };
}

import { findStep, hasLocator, type Automation, type AutomationPatch } from "./types.js";

export function applyPatches(automation: Automation, patches: AutomationPatch[]): Automation {
  const next = structuredClone(automation);
  for (const patch of patches) {
    if (patch.type !== "replace-locator") {
      throw new Error(`Unsupported patch: ${String(patch.type)}`);
    }
    const found = findStep(next, patch.stepId);
    if (found.step.type === "navigate") {
      throw new Error("Cannot replace a locator on a navigate step");
    }
    if (!hasLocator(found.step)) {
      throw new Error(`Step ${patch.stepId} has no locator`);
    }
    found.step.locator = structuredClone(patch.locator);
  }
  return next;
}

export function locatorPatch(stepId: string, locator: AutomationPatch["locator"]): AutomationPatch {
  return { type: "replace-locator", stepId, locator };
}

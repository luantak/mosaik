import type { Step } from "../../core/types.js";
import { resolveStepValue } from "../../core/index.js";
import { bindLocator } from "../../runtime/locators.js";

export function discoveryOperation(step: Step, inputs: Record<string, unknown>) {
  if (step.type === "click") return { type: step.type, locator: bindLocator(step.locator, inputs) };
  if (step.type === "fill" || step.type === "select")
    return {
      type: step.type,
      locator: bindLocator(step.locator, inputs),
      value: resolveStepValue(step.value, inputs),
    };
  if (step.type === "navigate") return { type: step.type, url: resolveStepValue(step.url, inputs) };
  return undefined;
}

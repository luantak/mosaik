import type { Step } from "../../core/types.js";
import { resolveSelectValue, resolveStepValue } from "../../core/index.js";
import { bindLocator } from "../../runtime/locators.js";

export function discoveryOperation(step: Step, inputs: Record<string, unknown>) {
  switch (step.type) {
    case "back":
      return { type: "back" };
    case "click":
      return {
        type: "click",
        locator: bindLocator(step.locator, inputs),
        ...(step.button === undefined ? {} : { button: step.button }),
        ...(step.clickCount === undefined ? {} : { clickCount: step.clickCount }),
        ...(step.modifiers === undefined ? {} : { modifiers: step.modifiers }),
        ...(step.dialog === undefined
          ? {}
          : {
              dialog: {
                action: step.dialog.action,
                ...(step.dialog.promptText === undefined
                  ? {}
                  : { promptText: resolveStepValue(step.dialog.promptText, inputs) }),
              },
            }),
      };
    case "drag":
      return {
        type: "drag",
        locator: bindLocator(step.locator, inputs),
        target: bindLocator(step.target, inputs),
      };
    case "hover":
      return { type: step.type, locator: bindLocator(step.locator, inputs) };
    case "fill":
      return {
        type: "fill",
        locator: bindLocator(step.locator, inputs),
        value: resolveStepValue(step.value, inputs),
      };
    case "select":
      return {
        type: "select",
        locator: bindLocator(step.locator, inputs),
        value: resolveSelectValue(step.value, inputs),
      };
    case "upload":
      return {
        type: "upload",
        locator: bindLocator(step.locator, inputs),
        file: resolveStepValue(step.file, inputs),
      };
    case "navigate":
      return { type: "navigate", url: resolveStepValue(step.url, inputs) };
    case "extract-text":
    case "extract-list":
      return undefined;
  }
}

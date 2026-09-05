import type { Page } from "playwright";
import {
  CompileError,
  compile,
  hasLocator,
  isStepValue,
  type Automation,
  type LocatorDefinition,
} from "../core/index.js";
import { resolveLocator } from "../runtime/locators.js";
import { draftSteps } from "./draft.js";
import type { DiscoveryRequest } from "./types.js";

export type DraftValidationErrorType =
  | "empty-draft"
  | "compile-error"
  | "unknown-input-reference"
  | "extract-locator-too-coarse"
  | "locator-not-found"
  | "locator-ambiguous"
  | "unsupported-step-type"
  | "external-side-effect"
  | "goal-not-reached"
  | "verification-not-unverified"
  | "invalid-output-key";

export interface DraftValidationError {
  type: DraftValidationErrorType;
  message: string;
  stepId?: string;
  key?: string;
  locator?: LocatorDefinition;
}

export interface DraftValidationResult {
  valid: boolean;
  errors: DraftValidationError[];
}

const COARSE_CSS_ROOTS = new Set(["html", "body", ":root", "main"]);

export function isCoarseExtractLocator(locator: LocatorDefinition): boolean {
  if (locator.strategy === "role" && locator.role.toLowerCase() === "main") {
    return locator.name === undefined && locator.within === undefined;
  }
  if (locator.strategy !== "css") return false;
  const selector = locator.selector.trim().toLowerCase().replace(/\s+/g, " ");
  const bare = selector.replace(/>/g, " ").replace(/\s+/g, " ").trim();
  if (COARSE_CSS_ROOTS.has(bare)) return true;
  return bare.split(" ").every((part) => COARSE_CSS_ROOTS.has(part));
}

export function validateDraftIntegrity(input: {
  automation: Automation;
  request: DiscoveryRequest;
  goalReached: boolean;
}): DraftValidationResult {
  const errors: DraftValidationError[] = [];
  const steps = input.automation.actions[0]?.steps ?? [];
  if (steps.length === 0) {
    errors.push({ type: "empty-draft", message: "Draft has no steps" });
  }
  try {
    if (steps.length > 0) compile(input.automation);
  } catch (error) {
    errors.push({
      type: "compile-error",
      message: error instanceof CompileError ? error.message : String(error),
    });
  }

  if (input.automation.verification?.status !== "unverified") {
    errors.push({
      type: "verification-not-unverified",
      message: "Discovery may only save verification status unverified",
    });
  }
  if (!input.goalReached) {
    errors.push({ type: "goal-not-reached", message: "Recorded goal result is not reached" });
  }

  const allowed = new Set(input.request.constraints.allowedStepTypes);
  const inputs = input.request.inputs ?? {};
  for (const step of steps) {
    if (!allowed.has(step.type)) {
      errors.push({
        type: "unsupported-step-type",
        stepId: step.id,
        message: `Step type ${step.type} is not allowed`,
      });
    }
    if (
      step.safety === "external-side-effect" &&
      !input.request.constraints.allowExternalSideEffects
    ) {
      errors.push({
        type: "external-side-effect",
        stepId: step.id,
        message: "external-side-effect steps are not allowed",
      });
    }
    if ((step.type === "fill" || step.type === "select") && isStepValue(step.value)) {
      if (step.value.kind === "input" && !(step.value.key in inputs)) {
        errors.push({
          type: "unknown-input-reference",
          stepId: step.id,
          key: step.value.key,
          message: `Input key ${step.value.key} is not in the discovery request`,
        });
      }
    }
    if (step.type === "extract-text") {
      if (step.output.length === 0) {
        errors.push({
          type: "invalid-output-key",
          stepId: step.id,
          message: "extract-text requires an output key",
        });
      }
      if (isCoarseExtractLocator(step.locator)) {
        errors.push({
          type: "extract-locator-too-coarse",
          stepId: step.id,
          locator: step.locator,
          message: "extract-text locator is a document or root container",
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export async function validateDraftLocatorsOnPage(
  page: Page,
  automation: Automation,
): Promise<DraftValidationError[]> {
  const errors: DraftValidationError[] = [];
  for (const step of draftSteps(automation)) {
    if (!hasLocator(step)) continue;
    const matches = await resolveLocator(page, step.locator)
      .count()
      .catch(() => 0);
    if (matches > 1) {
      errors.push({
        type: "locator-ambiguous",
        stepId: step.id,
        locator: step.locator,
        message: `Locator is ambiguous (${matches} matches)`,
      });
      continue;
    }
    if (matches === 0 && step.type === "extract-text") {
      errors.push({
        type: "locator-not-found",
        stepId: step.id,
        locator: step.locator,
        message: "extract-text locator resolves to nothing on the current page",
      });
    }
  }
  return errors;
}

export function formatDraftErrors(errors: DraftValidationError[]): string {
  return errors.map((error) => error.message).join("; ");
}

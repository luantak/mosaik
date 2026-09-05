import { scopesEqual } from "./scope.js";
import type { AutomationPatch, Step } from "./types.js";
import { hasLocator } from "./types.js";

/**
 * Why the renamed-button DSH run spent 4 model requests:
 *
 * 1. The first run_code applied role=textbox/Email. Clicking that input
 *    made runStep succeed, so the automation returned a "validated" repair.
 * 2. The prompt then asked for a separate JSON reply after tools, which
 *    forced an extra inference turn even after a later correct patch.
 * 3. Later findCandidates scored against the working candidate, so after
 *    the Email patch, Proceed no longer looked sameRole.
 * 4. The adapter treated any updateLocator+runStep as success and never
 *    treated a complete run_code object as terminal, so DSH kept going.
 *
 * A terminal result is accepted only when it is structurally complete and
 * the patch is compatible with the failed step. That is not candidate
 * ranking; it is the contract for stopping.
 */

export interface ValidationOutcome {
  success: boolean;
  error?: string;
}

export interface ValidatedRepairResult {
  status: "repaired";
  candidateId: string;
  patches: AutomationPatch[];
  validation: {
    step: ValidationOutcome;
    action?: ValidationOutcome;
  };
  evidence: {
    candidateTested: boolean;
    uniqueMatch: boolean;
    visible: boolean;
    enabled?: boolean;
  };
  canonicalIrModified: false;
}

export interface NoRepairResult {
  status: "no-repair";
  reason: string;
}

export type TerminalRepairResult = ValidatedRepairResult | NoRepairResult;

export function parseTerminalRepairResult(value: unknown): TerminalRepairResult | undefined {
  const record = asRecord(value);
  if (record === undefined) return unwrapNested(value);
  if (record.status === "no-repair" && typeof record.reason === "string") {
    return { status: "no-repair", reason: record.reason };
  }
  if (record.status !== "repaired") return unwrapNested(value);
  if (typeof record.candidateId !== "string" || record.candidateId.length === 0) return undefined;
  if (!Array.isArray(record.patches) || record.patches.length === 0) return undefined;
  const patches = record.patches.filter(isPatch);
  if (patches.length === 0) return undefined;
  const validation = asRecord(record.validation);
  const step = asRecord(validation?.step);
  if (step?.success !== true) return undefined;
  const evidence = asRecord(record.evidence);
  if (
    evidence?.candidateTested !== true ||
    evidence.uniqueMatch !== true ||
    evidence.visible !== true
  ) {
    return undefined;
  }
  if (record.canonicalIrModified !== false) return undefined;
  const action = asRecord(validation?.action);
  return {
    status: "repaired",
    candidateId: record.candidateId,
    patches,
    validation: {
      step: { success: true, ...(typeof step.error === "string" ? { error: step.error } : {}) },
      ...(action?.success === undefined
        ? {}
        : {
            action: {
              success: action.success === true,
              ...(typeof action.error === "string" ? { error: action.error } : {}),
            },
          }),
    },
    evidence: {
      candidateTested: true,
      uniqueMatch: true,
      visible: true,
      ...(typeof evidence.enabled === "boolean" ? { enabled: evidence.enabled } : {}),
    },
    canonicalIrModified: false,
  };
}

export function isCompleteValidatedRepair(
  value: TerminalRepairResult | undefined,
): value is ValidatedRepairResult {
  return value !== undefined && value.status === "repaired";
}

export function patchCompatibleWithStep(step: Step, patch: AutomationPatch): boolean {
  if (patch.type !== "replace-locator") return false;
  if (step.type === "navigate" || !hasLocator(step)) return false;
  const locator = patch.locator;
  if (step.locator.within !== undefined && !scopesEqual(step.locator.within, locator.within)) {
    return false;
  }
  if (locator.strategy !== "role") {
    return (
      step.type !== "click" ||
      locator.strategy === "text" ||
      locator.strategy === "test-id" ||
      locator.strategy === "css"
    );
  }
  if (step.type === "click") return locator.role === "button" || locator.role === "link";
  if (step.type === "fill") return locator.role === "textbox" || locator.role === "searchbox";
  if (step.type === "select") return locator.role === "combobox" || locator.role === "listbox";
  if (step.type === "extract-text" || step.type === "extract-list") return true;
  return false;
}

export function isAcceptableValidatedRepair(step: Step, result: ValidatedRepairResult): boolean {
  return result.patches.every((patch) => patchCompatibleWithStep(step, patch));
}

function unwrapNested(value: unknown): TerminalRepairResult | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (record.result !== undefined) return parseTerminalRepairResult(record.result);
  return undefined;
}

function isPatch(value: unknown): value is AutomationPatch {
  const record = asRecord(value);
  const locator = asRecord(record?.locator);
  return (
    record?.type === "replace-locator" &&
    typeof record.stepId === "string" &&
    typeof locator?.strategy === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

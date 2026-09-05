export type StepSafety = "read-only" | "browser-local" | "external-side-effect";

export type LocatorScope =
  | { kind: "container"; locator: LocatorDefinition }
  | { kind: "form"; name: string }
  | { kind: "landmark"; role: string; name?: string };

export interface LocatorContext {
  form?: {
    id?: string;
    name?: string;
    accessibleName?: string;
  };
  landmark?: {
    role?: string;
    name?: string;
  };
  ancestorLabels?: string[];
}

export type LocatorDefinition = LocatorBindings &
  (
    | { strategy: "role"; role: string; name?: string; exact?: boolean; within?: LocatorScope }
    | { strategy: "text"; text: string; exact?: boolean; within?: LocatorScope }
    | { strategy: "label"; label: string; exact?: boolean; within?: LocatorScope }
    | { strategy: "test-id"; testId: string; within?: LocatorScope }
    | { strategy: "css"; selector: string; within?: LocatorScope }
  );

export interface LocatorBindings {
  /** Typed replacement of semantic values, never executable selector text. */
  bindings?: Partial<Record<"name" | "text" | "label" | "testId", StepValue>>;
  attribute?: { name: string; value: FillValue };
}

export type Condition =
  | { kind: "all" | "any"; conditions: Condition[] }
  | { kind: "url"; value: FillValue; comparison?: "equals" | "contains" }
  | {
      kind: "count";
      locator: LocatorDefinition;
      count: number;
      comparison?: "equals" | "gte" | "lte";
    }
  | { kind: "visible" | "enabled"; locator: LocatorDefinition; value?: boolean }
  | {
      kind: "text" | "attribute";
      locator: LocatorDefinition;
      name?: string;
      value: FillValue;
      comparison?: "equals" | "contains";
    }
  | { kind: "changed"; locator: LocatorDefinition; attribute?: string };

export interface StepConditions {
  ready?: Condition;
  completion?: Condition;
  conditionTimeoutMs?: number;
}

export interface ExecutionContextId {
  tab: string;
  frame: string;
}

export interface ClickStep extends StepConditions {
  id: string;
  type: "click";
  safety: StepSafety;
  locator: LocatorDefinition;
}

export type StepValue =
  | { kind: "literal"; value: string }
  | { kind: "input"; key: string; prefix?: string; suffix?: string };

export type FillValue = string | StepValue;

export interface FillStep extends StepConditions {
  id: string;
  type: "fill";
  safety: StepSafety;
  locator: LocatorDefinition;
  value: FillValue;
}

export interface SelectStep extends StepConditions {
  id: string;
  type: "select";
  safety: StepSafety;
  locator: LocatorDefinition;
  value: FillValue;
}

export interface NavigateStep extends StepConditions {
  id: string;
  type: "navigate";
  safety: StepSafety;
  url: FillValue;
}

export interface ExtractTextStep extends StepConditions {
  id: string;
  type: "extract-text";
  safety: StepSafety;
  locator: LocatorDefinition;
  output: string;
}

export type ListField = { optional?: boolean } & (
  | { source: "text"; locator?: LocatorDefinition }
  | { source: "attr"; name: string; locator?: LocatorDefinition }
  | { source: "url"; name: string; locator?: LocatorDefinition }
);

export interface ExtractListStep extends StepConditions {
  empty?: Condition;
  id: string;
  type: "extract-list";
  safety: StepSafety;
  locator: LocatorDefinition;
  output: string;
  fields: Record<string, ListField>;
}

export type Step =
  | ClickStep
  | FillStep
  | SelectStep
  | NavigateStep
  | ExtractTextStep
  | ExtractListStep;

export interface Action {
  id: string;
  name: string;
  steps: Step[];
}

export type AutomationVerificationStatus = "unverified" | "verified" | "invalid";

export interface AutomationVerification {
  status: AutomationVerificationStatus;
  discoveryGoalReached?: boolean;
  discoveryValidationSucceeded?: boolean;
}

export interface AutomationVersionStats {
  successfulRuns: number;
  failedRuns: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

export interface AutomationVersionRecord {
  version: number;
  stats: AutomationVersionStats;
}

export interface Automation {
  id: string;
  version: number;
  actions: Action[];
  verification?: AutomationVerification;
  runStats?: AutomationVersionStats;
  versionHistory?: AutomationVersionRecord[];
}

export type FailureType =
  | "invalid-input"
  | "unsupported-state"
  | "ambiguous-state"
  | "condition-failed"
  | "uncertain-outcome"
  | "extraction-failed"
  | "locator-not-found"
  | "locator-ambiguous"
  | "element-not-visible"
  | "element-disabled"
  | "navigation-failed"
  | "unexpected-page"
  | "timeout"
  | "assertion-failed"
  | "authentication-failed"
  | "external-service-error"
  | "unknown";

export interface FailureEvidence {
  matchCount?: number;
  similarNames?: string[];
  httpStatus?: number;
}

export interface AutomationFailure {
  runId: string;
  automationId: string;
  actionId: string;
  stepId: string;
  step: Step;
  error: { type: FailureType; message: string };
  page: { url: string; title?: string };
  artifacts: {
    screenshot?: string;
    accessibilitySnapshot?: string;
    overviewText?: string;
    consoleLogs?: string[];
    networkErrors?: string[];
  };
  evidence?: FailureEvidence;
}

export type FailureCategory =
  | "repairable-browser"
  | "retryable"
  | "auth"
  | "infra"
  | "unsafe"
  | "unknown";

export interface FailureClassification {
  category: FailureCategory;
  confidence: number;
  reason: string;
}

export type AutomationPatch = {
  type: "replace-locator";
  stepId: string;
  locator: LocatorDefinition;
};

export interface RepairCandidate {
  id: string;
  baseVersion: number;
  changes: AutomationPatch[];
}

export interface RepairConstraints {
  allowedPatchTypes: Array<AutomationPatch["type"]>;
  maxCandidates: number;
  maxValidationRuns: number;
  mayChangeActionStructure: boolean;
  mayChangeNavigation: boolean;
}

export const DEFAULT_REPAIR_CONSTRAINTS: RepairConstraints = {
  allowedPatchTypes: ["replace-locator"],
  maxCandidates: 5,
  maxValidationRuns: 6,
  mayChangeActionStructure: false,
  mayChangeNavigation: false,
};

export interface RepairRequest {
  mode?: "live-continuation";
  inputs?: Record<string, unknown>;
  failure: AutomationFailure;
  automation: Automation;
  constraints: RepairConstraints;
}

export type RunEventType =
  | "run.started"
  | "run.finished"
  | "step.started"
  | "step.succeeded"
  | "step.failed"
  | "failure.classified"
  | "repair.started"
  | "repair.proposed"
  | "repair.rejected"
  | "repair.sequence.started"
  | "repair.step.started"
  | "repair.step.proposed"
  | "repair.step.accepted-working"
  | "repair.step.failed"
  | "repair.sequence.completed"
  | "repair.sequence.rejected"
  | "repair.approval.required"
  | "validation.started"
  | "validation.finished"
  | "discovery.started"
  | "exploration.action"
  | "draft.step.added"
  | "draft.step.updated"
  | "draft.step.removed"
  | "discovery.goal.reached"
  | "discovery.completed"
  | "discovery.refused"
  | "automation.verification.changed";

export interface RunEvent {
  t: number;
  type: RunEventType;
  runId: string;
  [key: string]: unknown;
}

export function isStepValue(value: FillValue): value is StepValue {
  return typeof value !== "string";
}

export function stepValuePresent(value: FillValue): boolean {
  if (typeof value === "string") return value.length > 0;
  return value.kind === "literal"
    ? typeof value.value === "string" && value.value.length > 0
    : value.kind === "input" &&
        typeof value.key === "string" &&
        value.key.length > 0 &&
        (value.prefix === undefined || typeof value.prefix === "string") &&
        (value.suffix === undefined || typeof value.suffix === "string");
}

export function resolveStepValue(value: FillValue, inputs: Record<string, unknown> = {}): string {
  if (typeof value === "string") return value;
  if (value.kind === "literal") return value.value;
  const resolved = lookupInput(inputs, value.key);
  if (resolved === undefined || resolved === null) {
    throw new Error(
      `Missing input: ${value.key}. During discovery, call setExampleInputs({values: JSON.stringify({${JSON.stringify(value.key)}: observedValue})}) before testing or submitting this input binding. Use the observed value; do not repeat an already successful browser operation.`,
    );
  }
  if (
    (value.prefix !== undefined && typeof value.prefix !== "string") ||
    (value.suffix !== undefined && typeof value.suffix !== "string")
  )
    throw new Error("Input prefix and suffix must be strings");
  return (value.prefix ?? "") + String(resolved) + (value.suffix ?? "");
}

export function lookupInput(inputs: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(inputs, key)) return inputs[key];
  const parts = key.split(".");
  let current: unknown = inputs;
  for (const part of parts) {
    if (current === undefined || current === null || typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function hasLocator(
  step: Step,
): step is ClickStep | FillStep | SelectStep | ExtractTextStep | ExtractListStep {
  return (
    step.type === "click" ||
    step.type === "fill" ||
    step.type === "select" ||
    step.type === "extract-text" ||
    step.type === "extract-list"
  );
}

export function findAction(automation: Automation, actionId: string): Action {
  const action = automation.actions.find((entry) => entry.id === actionId);
  if (action === undefined) throw new Error(`Unknown action: ${actionId}`);
  return action;
}

export function findStep(
  automation: Automation,
  stepId: string,
): { action: Action; step: Step; index: number } {
  for (const action of automation.actions) {
    const index = action.steps.findIndex((step) => step.id === stepId);
    if (index >= 0) {
      const step = action.steps[index];
      if (step !== undefined) return { action, step, index };
    }
  }
  throw new Error(`Unknown step: ${stepId}`);
}

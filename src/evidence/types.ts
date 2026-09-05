import type { Condition, ExecutionContextId, LocatorDefinition } from "../core/types.js";

export interface DomEvidence {
  html: string;
  complete: boolean;
  redacted: boolean;
  /** Properties whose browser semantics cannot be reconstructed offline. */
  unsupported: string[];
}
export interface ActionCase {
  schemaVersion: 1;
  id: string;
  siteId: string;
  actionId: string;
  implementationId: string;
  contractVersion: number;
  contractFingerprint: string;
  implementationVersion: number;
  runId: string;
  capturedAt: number;
  context: ExecutionContextId;
  inputs: Record<string, unknown>;
  inputsComplete: boolean;
  before: DomEvidence;
  after: DomEvidence;
  precondition?: Condition;
  completion?: Condition;
  observations: { precondition: boolean | null; completion: boolean | null };
  steps: Array<{
    stepId: string;
    dom: DomEvidence;
    locator?: LocatorDefinition;
    matches?: number;
    tags?: string[];
    raw?: unknown;
  }>;
  output: unknown;
  expectations: Array<{
    stepId: string;
    value: unknown;
    provenance: "observed" | "condition-checked" | "independently-asserted";
  }>;
  fingerprint: string;
}
export interface CaseCheck {
  caseId: string;
  caseVersion: number;
  implementationVersion: number;
  check: string;
  status: "pass" | "fail" | "inconclusive";
  reason: string;
}
export interface FailedActionCase extends ActionCase {
  failure: { stepId: string; type: import("../core/types.js").FailureType };
}
export interface ActionCaseStore {
  saveFailure?(record: FailedActionCase): Promise<void>;
  save(record: ActionCase): Promise<void>;
  list(actionId: string): Promise<ActionCase[]>;
  inspect(actionId: string): Promise<{ cases: number; bytes: number; incomplete: number }>;
}

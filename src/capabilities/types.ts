import type {
  AutomationVerificationStatus,
  AutomationVersionRecord,
  AutomationVersionStats,
  Step,
  Condition,
  StepSafety,
} from "../core/index.js";

export type ActionType = ActionTypeBase & { optional?: true };

type ActionTypeBase =
  | { type: "string" }
  | {
      type: "number";
      format?:
        | "decimal-point"
        | "decimal-comma"
        | "currency-decimal-point"
        | "currency-decimal-comma";
    }
  | { type: "boolean" }
  | { type: "array"; items: ActionType }
  | { type: "object"; properties: Record<string, ActionType> };

export type ActionSchema = Record<string, ActionType>;

export interface ActionImplementation {
  id?: string;
  precondition?: Condition;
  completion?: Condition;
  conditionTimeoutMs?: number;
  steps: Step[];
}

export interface SiteActionDefinition {
  id: string;
  siteId: string;
  name: string;
  description: string;
  aliases?: string[];
  contexts?: string[];
  inputs: ActionSchema;
  outputs: ActionSchema;
  implementation: ActionImplementation;
  implementations?: ActionImplementation[];
  contractVersion?: number;
  verificationBasis?: "legacy-execution" | "condition-checked";
  safety: StepSafety;
  version: number;
  interfaceVersion: number;
  verification: AutomationVerificationStatus;
  runStats?: AutomationVersionStats;
  versionHistory?: AutomationVersionRecord[];
}

export interface SiteActionSummary {
  verificationBasis?: "legacy-execution" | "condition-checked";
  implementations?: Array<{ id: string; version: number }>;
  evidence?: { cases: number; bytes: number; incomplete: number };
  id: string;
  siteId: string;
  name: string;
  description: string;
  aliases?: string[];
  contexts?: string[];
  signature: string;
  inputs: ActionSchema;
  outputs: ActionSchema;
  safety: StepSafety;
  version: number;
  interfaceVersion: number;
  verification: AutomationVerificationStatus;
}

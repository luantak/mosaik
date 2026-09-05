import type { Automation, LocatorDefinition, Step } from "../core/index.js";

export type DiscoveryStepType = Step["type"];

export interface DiscoveryConstraints {
  allowedStepTypes: DiscoveryStepType[];
  maxSteps: number;
  maxExplorationActions: number;
  maxModelRequests: number;
  maxRunCodeExecutions: number;
  allowExternalSideEffects: boolean;
}

export const DEFAULT_DISCOVERY_CONSTRAINTS: DiscoveryConstraints = {
  allowedStepTypes: ["navigate", "fill", "select", "click", "extract-text"],
  maxSteps: 16,
  maxExplorationActions: 40,
  maxModelRequests: 8,
  maxRunCodeExecutions: 8,
  allowExternalSideEffects: false,
};

export type DiscoveryGoal =
  | { type: "url"; matches: string }
  | { type: "visible"; locator: LocatorDefinition }
  | { type: "text"; contains: string }
  | { type: "agent-confirmed" };

export interface DiscoveryRequest {
  id: string;
  task: string;
  startUrl?: string;
  inputs?: Record<string, unknown>;
  goal?: DiscoveryGoal;
  constraints: DiscoveryConstraints;
}

export type DiscoveryOutcome =
  | "discovered"
  | "correctly-refused"
  | "wrong-automation"
  | "invalid-draft"
  | "budget-exhausted"
  | "runtime-failure";

export interface DiscoveryMetrics {
  modelRequests: number;
  runCodeExecutions: number;
  nestedToolCalls: number;
  explorationActions: number;
  draftMutations: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  finalStepCount: number;
  locatorProvenance?: Array<{ stepId: string; source: string }>;
}

export interface DiscoveryProposal {
  automation: Automation;
  verification: {
    status: "unverified";
    discoveryGoalReached: boolean;
  };
  outcome: DiscoveryOutcome;
  metrics: DiscoveryMetrics;
}

export interface DiscoveryDraft {
  automation: Automation;
}

import type { AutomationPatch, RepairCandidate, RepairRequest } from "../core/index.js";
import type { DiscoveryProposal, DiscoveryRequest } from "../discovery/index.js";
import type { AgentRunMetrics, TrajectoryEntry } from "./metrics.js";
import type { SiteActionDefinition, SiteActionSummary } from "../capabilities/types.js";
import type { StepSafety } from "../core/types.js";
import type { ComposedAutomation, AutomationExecutionResult } from "../automations/types.js";

export interface RepairProposal {
  statePatch?: import("../capabilities/implementations.js").StateImplementationPatch;
  success: boolean;
  candidate?: RepairCandidate;
  patches?: AutomationPatch[];
  validated: boolean;
  requiresApproval?: boolean;
  rejected?: { reason: string };
  modelResponse: string;
  metrics: AgentRunMetrics;
  trajectory: TrajectoryEntry[];
}

export interface RepairAgent {
  generateLiveRepair?(
    request: RepairRequest,
    page: import("playwright").Page,
  ): Promise<RepairProposal>;
  generateRepair(request: RepairRequest): Promise<RepairProposal>;
}

export interface DiscoveryAgent {
  discover(request: DiscoveryRequest): Promise<DiscoveryProposal | null>;
}

export interface AgentBudgets {
  maxModelRequests: number;
  maxRunCodeExecutions: number;
  maxNestedToolCalls: number;
  maxActionCalls: number;
  executionTimeoutMs: number;
}

export interface CompositionSafetyConstraints {
  allowedActionSafety: StepSafety[];
  allowExternalSideEffects: boolean;
}

export interface CapabilityCompositionRequest {
  task: string;
  siteId: string;
  startUrl: string;
  inputs: Record<string, unknown>;
  safety: CompositionSafetyConstraints;
  budgets: AgentBudgets;
  automationId?: string;
}

export interface CompositionMetrics extends AgentRunMetrics {
  actionsConsidered: number;
  actionsReused: number;
  actionsDiscovered: number;
  unnecessaryRediscoveries: number;
  generatedAutomationLines: number;
  generatedAutomationNodes: number;
  timings?: {
    totalMs: number;
    agentMs: number;
    outerCompositionMs: number;
    outcomeReviewMs?: number;
    nestedDiscoveryMs: number;
    deterministicExecutionMs: number;
    hostOverheadMs: number;
    firstActionMs?: number;
    firstActionKind?: "discovery" | "automation";
    firstBrowserActionMs?: number;
    firstBrowserActionKind?:
      | "discovery-navigation"
      | "automation-navigation"
      | "planning-navigation";
  };
}

export interface CapabilityCompositionResult {
  status: "completed" | "refused" | "failed";
  completionMode?: "automation" | "discovery";
  attempts?: Array<{
    execution: AutomationExecutionResult | undefined;
    outcome: import("./outcome.js").TaskOutcome;
    automation: ComposedAutomation | undefined;
  }>;
  answer?: string;
  outcome?: import("./outcome.js").TaskOutcome;
  automation?: ComposedAutomation;
  reusedActions: string[];
  discoveredActions: string[];
  actionsConsidered: SiteActionSummary[];
  execution?: AutomationExecutionResult;
  reason?: string;
  runDirectory?: string;
  metrics: CompositionMetrics;
  trajectory: TrajectoryEntry[];
}

export interface CompositionProgressEvent {
  kind: "status" | "tool-call" | "tool-result" | "browser" | "file";
  message: string;
  detail?: string;
}

export interface CompositionRunOptions {
  signal?: AbortSignal;
  onProgress?: (event: CompositionProgressEvent) => void;
  runDirectory?: string;
  outputDirectory?: string;
}

export interface CapabilityCompositionAgent {
  compose(
    request: CapabilityCompositionRequest,
    options?: CompositionRunOptions,
  ): Promise<CapabilityCompositionResult>;
}

export interface ReusableActionDiscoveryRequest {
  task: string;
  capabilityName?: string;
  capabilityIntent: string;
  siteId: string;
  startUrl: string;
  inputs: Record<string, unknown>;
  prerequisiteActions?: string[];
  allowRepresentativeItem?: boolean;
  safety: CompositionSafetyConstraints;
  budgets: AgentBudgets;
}

export type ReusableActionDiscoveryResult =
  | {
      status: "discovered";
      observedPage?: { url: string; title: string };
      action: SiteActionDefinition;
      metrics: AgentRunMetrics;
      trajectory: TrajectoryEntry[];
    }
  | {
      status: "refused";
      reason: string;
      metrics: AgentRunMetrics;
      trajectory: TrajectoryEntry[];
    }
  | {
      status: "failed";
      reason: string;
      metrics: AgentRunMetrics;
      trajectory: TrajectoryEntry[];
    };

export interface ReusableActionDiscoveryAgent {
  discoverReusableAction(
    request: ReusableActionDiscoveryRequest,
  ): Promise<ReusableActionDiscoveryResult>;
}

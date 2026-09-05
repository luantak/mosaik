import type { ActionSchema } from "../capabilities/types.js";
import type { AutomationFailure } from "../core/index.js";

export interface AutomationDependency {
  actionId: string;
  actionVersion: number;
  interfaceVersion?: number;
  inputs?: ActionSchema;
  outputs?: ActionSchema;
}

export interface ComposedAutomation {
  id: string;
  siteId: string;
  source: string;
  version: number;
  actionIds?: string[];
  dependencies?: AutomationDependency[];
}

export interface ActionHost {
  invoke(name: string, args: unknown): Promise<unknown>;
}

export interface RepairCoordinationMetrics {
  repairAttempts: number;
  repairOwners: number;
  repairWaiters: number;
  repairsCommitted: number;
  repairsDeduplicated: number;
  staleRepairConflicts: number;
  callersRecoveredFromSharedRepair: number;
}

export interface SharedActionRepairRecovery {
  kind: "shared-action-repair";
  actionId: string;
  fromVersion: number;
  toVersion: number;
  repairPerformedByCaller: boolean;
}

export interface AutomationOutputFile {
  path: string;
  relativePath: string;
  bytes: number;
}

export interface AutomationExecutionResult {
  origin?: "automation" | "discovery";
  discoveryObservations?: unknown[];
  coverage?: import("../evidence/types.js").CaseCheck[];
  success: boolean;
  value?: unknown;
  logs: string[];
  pageNavigation?: import("../runtime/page-evidence.js").PageNavigationEvidence;
  actionResults?: Array<{ name: string; result: unknown }>;
  actionCalls: Array<{ name: string; args: unknown }>;
  files?: AutomationOutputFile[];
  error?: string;
  failure?: AutomationFailure;
  halted?: boolean;
  retried?: boolean;
  requiresApproval?: boolean;
  automation?: ComposedAutomation;
  repairedAction?: {
    id: string;
    fromVersion: number;
    toVersion: number;
  };
  recovery?: SharedActionRepairRecovery;
  repairCoordination?: RepairCoordinationMetrics;
}

export class AutomationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationValidationError";
  }
}

export class HostActionError extends Error {
  constructor(
    message: string,
    readonly failure?: AutomationExecutionResult["failure"],
    readonly halted = false,
  ) {
    super(message);
    this.name = "HostActionError";
  }
}

import type { Automation } from "../core/index.js";
import type { DiscoveryOutcome, DiscoveryProposal } from "./types.js";

export interface TerminalDiscoveryResult {
  status: "discovered";
  goalReached: true;
  automation: Automation;
  verification: {
    status: "unverified";
    discoveryGoalReached: true;
  };
}

export interface TerminalDiscoveryRefusal {
  status: "refused";
  reason: string;
}

export type TerminalDiscovery = TerminalDiscoveryResult | TerminalDiscoveryRefusal;

export function parseTerminalDiscovery(value: unknown): TerminalDiscovery | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (record.status === "refused" && typeof record.reason === "string") {
    return { status: "refused", reason: record.reason };
  }
  if (record.status !== "discovered") return undefined;
  const automation = asRecord(record.automation);
  const verification = asRecord(record.verification);
  if (automation === undefined || verification?.status !== "unverified") return undefined;
  if (record.goalReached !== true || verification.discoveryGoalReached !== true) return undefined;
  return {
    status: "discovered",
    goalReached: true,
    automation: record.automation as Automation,
    verification: {
      status: "unverified",
      discoveryGoalReached: true,
    },
  };
}

export function proposalFromTerminal(
  result: TerminalDiscoveryResult,
  extras: { outcome?: DiscoveryOutcome; metrics: DiscoveryProposal["metrics"] },
): DiscoveryProposal {
  return {
    automation: {
      ...result.automation,
      verification: result.verification,
    },
    verification: result.verification,
    outcome: extras.outcome ?? "discovered",
    metrics: extras.metrics,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

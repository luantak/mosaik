import { normalizeSiteId } from "../capabilities/site.js";

export interface RepairFlightKey {
  siteId: string;
  actionId: string;
  baseVersion: number;
}

export type SharedRepairOutcome =
  | {
      kind: "proposed-state";
      actionId: string;
      patch: import("../capabilities/implementations.js").StateImplementationPatch;
    }
  | { kind: "proposed"; actionId: string; patches: import("../core/types.js").AutomationPatch[] }
  | {
      kind: "repaired";
      actionId: string;
      fromVersion: number;
      toVersion: number;
    }
  | {
      kind: "already-advanced";
      actionId: string;
      currentVersion: number;
    }
  | {
      kind: "refused";
      actionId: string;
      requiresApproval?: boolean;
      reason?: string;
    }
  | {
      kind: "failed";
      actionId: string;
      error: string;
    };

export interface RepairFlightResult {
  outcome: SharedRepairOutcome;
  owned: boolean;
}

export function formatRepairFlightKey(key: RepairFlightKey): string {
  return `${normalizeSiteId(key.siteId)}::${key.actionId}@${key.baseVersion}`;
}

export class RepairFlightCoordinator {
  private readonly flights = new Map<string, Promise<SharedRepairOutcome>>();

  get size(): number {
    return this.flights.size;
  }

  async run(
    key: RepairFlightKey,
    owner: () => Promise<SharedRepairOutcome>,
  ): Promise<RepairFlightResult> {
    const id = formatRepairFlightKey(key);
    const existing = this.flights.get(id);
    if (existing !== undefined) {
      return { outcome: await existing, owned: false };
    }

    const promise = Promise.resolve()
      .then(owner)
      .catch((error: unknown): SharedRepairOutcome => ({
        kind: "failed",
        actionId: key.actionId,
        error: error instanceof Error ? error.message : String(error),
      }));
    this.flights.set(id, promise);
    try {
      return { outcome: await promise, owned: true };
    } finally {
      this.flights.delete(id);
    }
  }
}

export const sharedRepairFlights = new RepairFlightCoordinator();

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ComposedAutomation } from "../automations/types.js";
import type { SiteActionRegistry } from "../capabilities/lookup.js";
import type { SiteActionDefinition } from "../capabilities/types.js";
import { resolveAutomationSourceForExecution } from "../library/resolve-automation.js";
import { actionFingerprint, fingerprint, runtimeFingerprint } from "./fingerprint.js";
import { DurableJob, inspectJob } from "./store.js";
import { assertDurableActions } from "./runtime.js";
import type { AcceptedJobRepair, JobInspection, JobMetadata } from "./types.js";

export interface DurableRunOptions {
  directory: string;
  resume?: boolean;
}

export interface DurableMetadataOptions {
  input?: Record<string, unknown>;
  startUrl?: string;
  libraryRoot?: string;
  loadAutomationSource?: (id: string) => Promise<string | undefined>;
}

export function isDurableAutomation(automation: ComposedAutomation): boolean {
  return automation.durable === true || /\bctx\.batch\b/.test(automation.source);
}

export async function prepareDurableJob(
  automation: ComposedAutomation,
  actions: SiteActionDefinition[],
  options: {
    registry: SiteActionRegistry;
    job?: DurableRunOptions;
    input?: Record<string, unknown>;
    startUrl?: string;
    outputDirectory?: string;
    libraryRoot?: string;
    loadAutomationSource?: (id: string) => Promise<string | undefined>;
  },
): Promise<DurableJob | undefined> {
  if (!isDurableAutomation(automation) && !options.job) return undefined;
  const directory =
    options.job?.directory ??
    resolve(
      options.outputDirectory ?? ".mosaik/jobs",
      options.outputDirectory ? "job" : randomUUID(),
    );
  const inspection = options.job?.resume ? inspectJob(directory) : undefined;
  const recoveries = inspection ? planAcceptedRepairs(inspection, actions) : [];
  const expectedActions = actions.map(
    (action) => recoveries.find((recovery) => recovery.actionId === action.id)?.final ?? action,
  );
  const metadata = await prepareJobMetadata(automation, expectedActions, options);
  const job = DurableJob.open(directory, metadata, options.job?.resume ? { resume: true } : {});
  try {
    if (inspection) {
      // Inspection above is only a plan. No registry write occurs until the job lock is held.
      // Re-read every action to reject edits made while metadata and sources were loading.
      const currentActions = await Promise.all(
        actions.map(async (action) => {
          const current = await options.registry.get(action.id);
          if (!current)
            throw new Error(`Missing action ${action.id} while recovering an accepted repair`);
          return current;
        }),
      );
      const currentPlans = planAcceptedRepairs(inspection, currentActions);
      for (const recovery of currentPlans) {
        let current = currentActions.find((action) => action.id === recovery.actionId)!;
        for (const entry of recovery.remaining) {
          const latest = await options.registry.get(entry.actionId);
          if (!latest || actionFingerprint(latest) !== entry.fromFingerprint)
            throw new Error(`Action ${entry.actionId} changed during accepted repair recovery`);
          const updated = await options.registry.updateActionIfVersion({
            siteId: entry.action!.siteId,
            actionId: entry.actionId,
            expectedVersion: latest.version,
            next: structuredClone(entry.action!),
          });
          if (!updated.updated || actionFingerprint(updated.action) !== entry.toFingerprint)
            throw new Error(`Accepted repair recovery conflicted for action ${entry.actionId}`);
          current = updated.action;
        }
        const index = currentActions.findIndex((action) => action.id === recovery.actionId);
        currentActions[index] = current;
      }
      // The host is built from this array after preparation; it must use the restored snapshots.
      actions.splice(0, actions.length, ...currentActions);
    }
    return job;
  } catch (error) {
    job.close();
    throw error;
  }
}

/** Read-only resume preflight, including only journaled accepted-repair transitions. */
export async function prepareResumeMetadata(
  directory: string,
  automation: ComposedAutomation,
  actions: SiteActionDefinition[],
  options: DurableMetadataOptions,
): Promise<JobMetadata> {
  const inspection = inspectJob(directory);
  const plans = planAcceptedRepairs(inspection, actions);
  return prepareJobMetadata(
    automation,
    actions.map((action) => plans.find((plan) => plan.actionId === action.id)?.final ?? action),
    options,
  );
}

/** Shared read-only preflight for runtime execution and CLI resume. */
export async function prepareJobMetadata(
  automation: ComposedAutomation,
  actions: SiteActionDefinition[],
  options: DurableMetadataOptions,
): Promise<JobMetadata> {
  assertDurableActions(actions);
  const resolved = await resolveAutomationSourceForExecution({
    automation,
    ...(options.libraryRoot === undefined ? {} : { libraryRoot: options.libraryRoot }),
    ...(options.loadAutomationSource === undefined
      ? {}
      : { loadAutomationSource: options.loadAutomationSource }),
  });
  return {
    automation,
    input: options.input ?? {},
    ...(options.startUrl === undefined ? {} : { startUrl: options.startUrl }),
    runtimeFingerprint: fingerprint({
      runtime: await runtimeFingerprint(),
      executable: resolved.source,
    }),
    dependencies: Object.fromEntries(
      actions.map((action) => [action.id, actionFingerprint(action)]),
    ),
  };
}

interface RepairRecovery {
  actionId: string;
  final: SiteActionDefinition;
  remaining: AcceptedJobRepair[];
}

function planAcceptedRepairs(
  inspection: JobInspection,
  actions: SiteActionDefinition[],
): RepairRecovery[] {
  const chains = new Map<string, AcceptedJobRepair[]>();
  for (const entry of inspection.acceptedRepairs) {
    const chain = chains.get(entry.actionId) ?? [];
    const previous = chain.at(-1);
    if (
      previous &&
      (previous.toFingerprint !== entry.fromFingerprint || previous.toVersion !== entry.fromVersion)
    )
      throw new Error(`Accepted repair history is not contiguous for action ${entry.actionId}`);
    if (
      !entry.action ||
      entry.action.id !== entry.actionId ||
      entry.action.siteId !== inspection.metadata.automation.siteId ||
      entry.action.version !== entry.toVersion ||
      entry.toVersion <= entry.fromVersion ||
      actionFingerprint(entry.action) !== entry.toFingerprint
    )
      throw new Error(
        `Accepted repair snapshot is missing or incompatible for action ${entry.actionId}`,
      );
    assertDurableActions([entry.action]);
    chain.push(entry);
    chains.set(entry.actionId, chain);
  }
  const plans: RepairRecovery[] = [];
  if (actions.length !== Object.keys(inspection.metadata.dependencies).length)
    throw new Error("Job action dependencies changed; start a new job");
  for (const action of actions) {
    const expected = inspection.metadata.dependencies[action.id];
    const current = actionFingerprint(action);
    const chain = chains.get(action.id);
    if (!chain) {
      if (current !== expected)
        throw new Error(`Unrecorded action edit for ${action.id}; start a new job`);
      continue;
    }
    const final = chain.at(-1)!;
    if (final.toFingerprint !== expected)
      throw new Error(
        `Accepted repair history does not match job fingerprint for action ${action.id}`,
      );
    if (current === expected) {
      plans.push({ actionId: action.id, final: action, remaining: [] });
      continue;
    }
    const predecessor = chain.findIndex(
      (entry) => entry.fromFingerprint === current && entry.fromVersion === action.version,
    );
    if (predecessor === -1)
      throw new Error(
        `Unrecorded action edit for ${action.id}; accepted repairs cannot overwrite it`,
      );
    plans.push({ actionId: action.id, final: final.action!, remaining: chain.slice(predecessor) });
  }
  return plans;
}

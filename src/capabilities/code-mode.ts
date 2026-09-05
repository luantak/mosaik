import { typecheckAutomation } from "../automations/typecheck.js";
import { composeTask, type CapabilityNeed, type ComposeResult } from "./compose.js";
import { compileSiteAction } from "./define.js";
import { assertSiteCapability } from "./granularity.js";
import {
  getCapability,
  listCapabilities,
  searchCapabilities,
  toSummary,
  type SiteActionRegistry,
} from "./lookup.js";
import { matchNeed, normalizeCapabilityNeed, planTask } from "./plan.js";
import { normalizeSiteId } from "./site.js";
import type { SiteActionDefinition, SiteActionSummary } from "./types.js";
import { referencedActions, validateAutomation } from "../automations/validate.js";
import type { ComposedAutomation } from "../automations/types.js";

interface DiscoveryMetricSnapshot {
  modelRequests: number;
  codeExecutions: number;
  nestedToolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

type SessionDiscoveryResult =
  | SiteActionDefinition
  | {
      action: SiteActionDefinition;
      metrics: DiscoveryMetricSnapshot;
      observedPage?: { url: string; title: string };
    };

export interface CompositionSession {
  list(siteId: string): Promise<SiteActionSummary[]>;
  search(siteId: string, intent: string): Promise<SiteActionSummary[]>;
  get(actionId: string): Promise<SiteActionSummary | undefined>;
  plan(request: { siteId: string; task: string; needs: CapabilityNeed[] }): Promise<{
    siteId: string;
    task: string;
    inspected: true;
    considered: SiteActionSummary[];
    reuse: string[];
    missing: CapabilityNeed[];
    matches: Array<{ via: string; name?: string; need: CapabilityNeed; ambiguous?: true }>;
  }>;
  discover(
    need: CapabilityNeed & { siteId: string },
    prerequisiteActions?: string[],
  ): Promise<
    SiteActionSummary & {
      discoveryMetrics?: DiscoveryMetricSnapshot;
      observedPage?: { url: string; title: string };
    }
  >;
  compose(request: {
    siteId: string;
    task: string;
    needs: CapabilityNeed[];
    automationId?: string;
    automationSource?: string;
  }): Promise<ComposedAutomationView>;
  saveAutomation(automation: ComposedAutomation): Promise<TerminalComposition>;
}

export interface ComposedAutomationView {
  reused: string[];
  discovered: string[];
  rediscovered: string[];
  automation: ComposedAutomation;
  metrics: ComposeResult["metrics"];
  resolved: Array<{ need: CapabilityNeed; action: string }>;
}

export interface TerminalComposition {
  status: "composed";
  automation: ComposedAutomation;
  reused?: string[];
  discovered?: string[];
}

export function createCompositionSession(input: {
  suppliedInputs?: Record<string, unknown>;
  task?: string;
  registry: SiteActionRegistry;
  discover: (
    need: CapabilityNeed,
    prerequisiteActions?: string[],
  ) => Promise<SessionDiscoveryResult>;
  saveAutomation: (automation: ComposedAutomation) => Promise<void>;
}): CompositionSession {
  const inspected = new Set<string>();

  const inspect = (siteId: string): string => {
    const normalized = normalizeSiteId(siteId);
    inspected.add(normalized);
    return normalized;
  };

  const requireInspected = (siteId: string): string => {
    const normalized = normalizeSiteId(siteId);
    if (!inspected.has(normalized)) {
      throw new Error("Inspect site capabilities before composing or discovering");
    }
    return normalized;
  };

  return {
    async list(siteId) {
      return listCapabilities(input.registry, inspect(siteId));
    },
    async search(siteId, intent) {
      return searchCapabilities(input.registry, inspect(siteId), intent);
    },
    async get(actionId) {
      return getCapability(input.registry, actionId);
    },
    async plan(request) {
      inspect(request.siteId);
      const task = input.task ?? request.task;
      const plan = await planTask(input.registry, { ...request, task });
      return {
        siteId: plan.siteId,
        task: plan.task,
        inspected: true,
        considered: plan.considered,
        reuse: plan.reuse.map((action) => action.name),
        missing: plan.missing,
        matches: plan.matches.map((match) => ({
          via: match.via,
          need: match.need,
          ...(match.ambiguous === true ? { ambiguous: true as const } : {}),
          ...(match.action === undefined ? {} : { name: match.action.name }),
        })),
      };
    },
    async discover(need, prerequisiteActions) {
      const siteId = requireInspected(need.siteId);
      // This is a single capability lookup, not a standalone workflow. Its
      // dependencies refer to stages already validated by the composition plan.
      const existing = await matchNeed(
        input.registry,
        siteId,
        await input.registry.list(siteId),
        normalizeCapabilityNeed(need),
      );
      if (existing.ambiguous === true) {
        throw new Error("Capability search is ambiguous; refine the need before discovery");
      }
      if (existing.action !== undefined) {
        throw new Error(`Compatible action ${existing.action.name} already exists; reuse it`);
      }
      if (existing.need.name !== undefined) assertSiteCapability({ name: existing.need.name });
      const discovered = await input.discover(existing.need, prerequisiteActions);
      const raw = "action" in discovered ? discovered.action : discovered;
      // The need describes this invocation; only discovery defines reusable contexts.
      const created = compileSiteAction(raw);
      assertSiteCapability(created);
      await input.registry.save(created);
      return {
        ...toSummary(created),
        ...("action" in discovered
          ? {
              discoveryMetrics: discovered.metrics,
              ...(discovered.observedPage === undefined
                ? {}
                : { observedPage: discovered.observedPage }),
            }
          : {}),
      };
    },
    async compose(request) {
      const siteId = requireInspected(request.siteId);
      if (request.automationSource !== undefined) {
        assertMosaikAutomation(request.automationSource);
      }
      const composed = await composeTask(input.registry, {
        siteId,
        task: input.task ?? request.task,
        needs: request.needs,
        discover: async (need) => {
          const discovered = await input.discover(need);
          return "action" in discovered ? discovered.action : discovered;
        },
        ...(request.automationId === undefined ? {} : { automationId: request.automationId }),
        ...(request.automationSource === undefined
          ? {}
          : { generateAutomation: () => request.automationSource! }),
      });
      return {
        reused: composed.reused,
        discovered: composed.discovered,
        rediscovered: composed.rediscovered,
        metrics: composed.metrics,
        automation: composed.automation,
        resolved: composed.plan.matches.map((match, index) => ({
          need: match.need,
          action: composed.actions[index]!.name,
        })),
      };
    },
    async saveAutomation(automation) {
      requireInspected(automation.siteId);
      assertMosaikAutomation(automation.source);
      const actions = await input.registry.list(automation.siteId);
      const names = actions.map((action) => action.name);
      validateAutomation(automation.source, { actionNames: names });
      await typecheckAutomation(automation.source, actions, input.suppliedInputs);
      const byName = new Map(actions.map((action) => [action.name, action]));
      const selected = referencedActions(automation.source).map((name) => byName.get(name)!);
      const next: ComposedAutomation = {
        id: automation.id,
        siteId: normalizeSiteId(automation.siteId),
        source: automation.source,
        version:
          typeof automation.version === "number" && automation.version > 0 ? automation.version : 1,
        actionIds: selected.map((action) => action.id),
        dependencies: selected.map((action) => ({
          actionId: action.id,
          actionVersion: action.version,
          interfaceVersion: action.interfaceVersion,
          inputs: structuredClone(action.inputs),
          outputs: structuredClone(action.outputs),
        })),
      };
      await input.saveAutomation(next);
      return { status: "composed", automation: next };
    },
  };
}

export function assertMosaikAutomation(source: string): void {
  validateAutomation(source);
  if (/\bawait\s+tools\./.test(source) || /\brun_code\b/.test(source)) {
    throw new Error("Code Mode is not a persisted automation; save Mosaik TypeScript");
  }
}

export function unwrapCodeModeValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && "result" in value) {
    return (value as { result: unknown }).result;
  }
  return value;
}

export function parseTerminalComposition(value: unknown): TerminalComposition {
  const raw = unwrapCodeModeValue(value);
  if (raw === null || typeof raw !== "object") {
    throw new Error("Composition Code Mode result is missing");
  }
  const record = raw as Record<string, unknown>;
  if (record.status !== "composed") {
    throw new Error("Composition Code Mode result must have status composed");
  }
  const automation = record.automation;
  if (automation === null || typeof automation !== "object") {
    throw new Error("Composition Code Mode result is missing automation");
  }
  const body = automation as Record<string, unknown>;
  if (
    typeof body.id !== "string" ||
    typeof body.siteId !== "string" ||
    typeof body.source !== "string"
  ) {
    throw new Error("Composition Code Mode automation is incomplete");
  }
  assertMosaikAutomation(body.source);
  const parsed: TerminalComposition = {
    status: "composed",
    automation: {
      id: body.id,
      siteId: body.siteId,
      source: body.source,
      version: typeof body.version === "number" ? body.version : 1,
      ...(Array.isArray(body.actionIds)
        ? { actionIds: body.actionIds.filter((id): id is string => typeof id === "string") }
        : {}),
    },
  };
  if (Array.isArray(record.reused)) {
    parsed.reused = record.reused.filter((name): name is string => typeof name === "string");
  }
  if (Array.isArray(record.discovered)) {
    parsed.discovered = record.discovered.filter(
      (name): name is string => typeof name === "string",
    );
  }
  return parsed;
}

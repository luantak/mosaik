import { createCaseStore } from "../evidence/store.js";
import type { ActionCaseStore } from "../evidence/types.js";
import { assignCompatibilityVersions } from "./compatibility.js";
import { compileSiteAction } from "./define.js";
import { assertSiteCapability } from "./granularity.js";
import { formatSignature } from "./schema.js";
import { normalizeSiteId } from "./site.js";
import type { SiteActionDefinition, SiteActionSummary } from "./types.js";

export type ActionVersionUpdate =
  | { updated: true; action: SiteActionDefinition }
  | {
      updated: false;
      reason: "version-conflict";
      current?: SiteActionDefinition;
    };

export interface SiteActionRegistry {
  cases?: ActionCaseStore;
  save(action: SiteActionDefinition): Promise<void>;
  get(actionId: string): Promise<SiteActionDefinition | undefined>;
  list(siteId: string): Promise<SiteActionDefinition[]>;
  listSites(): Promise<string[]>;
  updateActionIfVersion(input: {
    siteId: string;
    actionId: string;
    expectedVersion: number;
    next: SiteActionDefinition;
  }): Promise<ActionVersionUpdate>;
}

export function createMemoryRegistry(seed: SiteActionDefinition[] = []): SiteActionRegistry {
  const byId = new Map<string, SiteActionDefinition>();
  for (const action of seed) {
    const compiled = compileSiteAction(action);
    assertSiteCapability(compiled);
    byId.set(compiled.id, compiled);
  }

  return {
    cases: createCaseStore(),
    async save(action) {
      const incoming = compileSiteAction(action);
      const compiled = compileSiteAction(
        assignCompatibilityVersions(byId.get(incoming.id), incoming),
      );
      assertSiteCapability(compiled);
      const existing = [...byId.values()].find(
        (entry) =>
          entry.siteId === compiled.siteId &&
          entry.name === compiled.name &&
          entry.id !== compiled.id,
      );
      if (existing !== undefined) {
        throw new Error(
          `Site ${compiled.siteId} already has an action named ${compiled.name} (${existing.id})`,
        );
      }
      byId.set(compiled.id, compiled);
    },

    async get(actionId) {
      return byId.get(actionId);
    },

    async list(siteId) {
      const normalized = normalizeSiteId(siteId);
      return [...byId.values()]
        .filter((action) => action.siteId === normalized)
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        );
    },

    async listSites() {
      return [...new Set([...byId.values()].map((action) => action.siteId))].sort();
    },

    async updateActionIfVersion(input) {
      return acceptActionVersion(byId, input);
    },
  };
}

function acceptActionVersion(
  byId: Map<string, SiteActionDefinition>,
  input: {
    siteId: string;
    actionId: string;
    expectedVersion: number;
    next: SiteActionDefinition;
  },
): ActionVersionUpdate {
  const incoming = compileSiteAction(input.next);
  const siteId = normalizeSiteId(input.siteId);
  if (incoming.id !== input.actionId) {
    throw new Error("Patched action id must match the update target");
  }
  if (incoming.siteId !== siteId) {
    throw new Error("Patched action site must match the update target");
  }
  const current = byId.get(input.actionId);
  if (current === undefined || current.version !== input.expectedVersion) {
    return {
      updated: false,
      reason: "version-conflict",
      ...(current === undefined ? {} : { current }),
    };
  }
  const compiled = compileSiteAction(assignCompatibilityVersions(current, incoming));
  assertSiteCapability(compiled);
  const clash = [...byId.values()].find(
    (entry) =>
      entry.siteId === compiled.siteId && entry.name === compiled.name && entry.id !== compiled.id,
  );
  if (clash !== undefined) {
    throw new Error(
      `Site ${compiled.siteId} already has an action named ${compiled.name} (${clash.id})`,
    );
  }
  byId.set(compiled.id, compiled);
  return { updated: true, action: compiled };
}

export function toSummary(action: SiteActionDefinition): SiteActionSummary {
  return {
    id: action.id,
    siteId: action.siteId,
    name: action.name,
    description: action.description,
    ...(action.aliases === undefined ? {} : { aliases: [...action.aliases] }),
    ...(action.contexts === undefined ? {} : { contexts: [...action.contexts] }),
    signature: formatSignature(action),
    inputs: structuredClone(action.inputs),
    outputs: structuredClone(action.outputs),
    safety: action.safety,
    version: action.version,
    interfaceVersion: action.interfaceVersion,
    verification: action.verification,
    verificationBasis: action.verificationBasis ?? "legacy-execution",
    ...(action.implementations
      ? {
          implementations: action.implementations.map((implementation) => ({
            id: implementation.id!,
            version: action.version,
          })),
        }
      : {}),
  };
}

export async function listCapabilities(
  registry: SiteActionRegistry,
  siteId: string,
): Promise<SiteActionSummary[]> {
  return Promise.all(
    (await registry.list(siteId)).map(async (action) => ({
      ...toSummary(action),
      ...(registry.cases ? { evidence: await registry.cases.inspect(action.id) } : {}),
    })),
  );
}

export async function getCapability(
  registry: SiteActionRegistry,
  actionId: string,
): Promise<SiteActionSummary | undefined> {
  const action = await registry.get(actionId);
  return action === undefined
    ? undefined
    : {
        ...toSummary(action),
        ...(registry.cases ? { evidence: await registry.cases.inspect(action.id) } : {}),
      };
}

export interface RankedCapability {
  summary: SiteActionSummary;
  score: number;
}

export async function rankCapabilities(
  registry: SiteActionRegistry,
  siteId: string,
  intent: string,
): Promise<RankedCapability[]> {
  const query = intent.trim().toLowerCase();
  const tokens = query.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  return (await listCapabilities(registry, siteId))
    .map((summary) => ({ summary, score: scoreSummary(summary, query, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.summary.name.localeCompare(right.summary.name),
    );
}

export async function searchCapabilities(
  registry: SiteActionRegistry,
  siteId: string,
  intent: string,
): Promise<SiteActionSummary[]> {
  return (await rankCapabilities(registry, siteId, intent)).map((entry) => entry.summary);
}

function scoreSummary(summary: SiteActionSummary, query: string, tokens: string[]): number {
  if (query.length === 0) return 1;
  const name = summary.name.toLowerCase();
  const description = summary.description.toLowerCase();
  const signature = summary.signature.toLowerCase();
  let score = 0;
  if (name === query) score += 100;
  if (name.includes(query)) score += 50;
  if (description.includes(query)) score += 20;
  if (signature.includes(query)) score += 10;
  for (const alias of summary.aliases ?? []) {
    const text = alias.toLowerCase();
    if (text === query) score += 80;
    if (text.includes(query)) score += 40;
  }
  for (const token of tokens) {
    if (name.includes(token)) score += 10;
    if (description.includes(token)) score += 5;
    if (Object.keys(summary.inputs).some((key) => key.toLowerCase().includes(token))) score += 3;
    if (Object.keys(summary.outputs).some((key) => key.toLowerCase().includes(token))) score += 2;
    if ((summary.aliases ?? []).some((alias) => alias.toLowerCase().includes(token))) score += 8;
  }
  return score;
}

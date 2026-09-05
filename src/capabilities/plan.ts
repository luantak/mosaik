import { bindingVerbsIn, splitIdent } from "./granularity.js";
import { listCapabilities, rankCapabilities, type RankedCapability } from "./lookup.js";
import type { SiteActionRegistry } from "./lookup.js";
import { normalizeSiteId } from "./site.js";
import type { SiteActionDefinition, SiteActionSummary } from "./types.js";

const SEARCH_REUSE_MIN_SCORE = 20;
const SEARCH_REUSE_LEAD = 10;

export const COMPOSITION_STEPS = [
  "inspect-capabilities",
  "reuse-known",
  "discover-missing",
  "generate-automation",
] as const;

export type CompositionStep = (typeof COMPOSITION_STEPS)[number];

export interface CapabilityNeed {
  stage?: string;
  name?: string;
  intent?: string;
  description?: string;
  context?: string;
  after?: string[];
  cardinality?: "once" | "per-item";
}

export interface CompositionPlan {
  siteId: string;
  task: string;
  considered: SiteActionSummary[];
  reuse: SiteActionDefinition[];
  missing: CapabilityNeed[];
  matches: PlanMatch[];
  inspected: true;
}

export interface PlanMatch {
  need: CapabilityNeed;
  via: "name" | "search" | "alias" | "none";
  action?: SiteActionDefinition;
  ambiguous?: true;
}

export async function planTask(
  registry: SiteActionRegistry,
  request: { siteId: string; task: string; needs: CapabilityNeed[] },
): Promise<CompositionPlan> {
  if (request.needs.length === 0) {
    throw new Error("composeTask requires at least one capability need");
  }
  const siteId = normalizeSiteId(request.siteId);
  const considered = await listCapabilities(registry, siteId);
  const known = await registry.list(siteId);
  const needs = request.needs.map(normalizeCapabilityNeed);
  validateWorkflowNeeds(needs);
  const matches: PlanMatch[] = [];
  for (const need of needs) {
    matches.push(await matchNeed(registry, siteId, known, need));
  }
  const reuse: SiteActionDefinition[] = [];
  const missing: CapabilityNeed[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    if (match.action) {
      if (seen.has(match.action.id)) continue;
      seen.add(match.action.id);
      reuse.push(match.action);
      continue;
    }
    missing.push(match.need);
  }
  return {
    siteId,
    task: request.task,
    considered,
    reuse,
    missing,
    matches,
    inspected: true,
  };
}

export function normalizeCapabilityNeed(need: CapabilityNeed): CapabilityNeed {
  if (need.name === undefined) return need;
  // Normalize spelling only; descriptions must not change the requested operation.
  if (/^[a-z][A-Za-z0-9]*$/.test(need.name)) return need;
  const parts = splitIdent(need.name);
  if (parts.length === 0) return need;
  const [first, ...rest] = parts;
  return {
    ...need,
    name: `${first?.toLowerCase() ?? ""}${rest
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`)
      .join("")}`,
  };
}

export async function matchNeed(
  registry: SiteActionRegistry,
  siteId: string,
  known: SiteActionDefinition[],
  need: CapabilityNeed,
): Promise<PlanMatch> {
  // Names and contexts identify library candidates. Descriptive prose is not
  // an executable contract; workflow checks and outcome review establish
  // whether the selected actions fulfill the request.
  if (need.name) {
    const exact = known.find(
      (action) => action.name === need.name && actionMatchesContext(action, need.context),
    );
    if (exact) return { need, via: "name", action: exact };
    const aliases = known.filter(
      (action) =>
        action.aliases?.includes(need.name!) && actionMatchesContext(action, need.context),
    );
    if (aliases.length === 1) return { need, via: "alias", action: aliases[0]! };
    if (aliases.length > 1) return { need, via: "none", ambiguous: true };
    return { need, via: "none" };
  }
  const query = [need.intent, need.description, need.context]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  if (!query) return { need, via: "none" };
  const compatibleIds = new Set(
    known.filter((action) => actionMatchesContext(action, need.context)).map((action) => action.id),
  );
  const ranked = filterByIntentVerb(await rankCapabilities(registry, siteId, query), query).filter(
    (entry) => compatibleIds.has(entry.summary.id),
  );
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < SEARCH_REUSE_MIN_SCORE) return { need, via: "none" };
  if (second && best.score < second.score + SEARCH_REUSE_LEAD) {
    return { need, via: "none", ambiguous: true };
  }
  const action = known.find(
    (candidate) =>
      candidate.id === best.summary.id && actionMatchesContext(candidate, need.context),
  );
  if (!action) return { need, via: "none" };
  return { need, via: "search", action };
}

export function validateWorkflowNeeds(needs: CapabilityNeed[]): void {
  const staged = needs.filter((need) => need.stage !== undefined);
  if (staged.length !== 0 && staged.length !== needs.length) {
    throw new Error("Workflow stages must identify every capability need");
  }
  const positions = new Map<string, number>();
  for (const [index, need] of needs.entries()) {
    if (need.stage === undefined) continue;
    const stage = need.stage.trim();
    if (stage.length === 0) throw new Error("Workflow stage ids must be non-empty");
    if (positions.has(stage)) throw new Error(`Duplicate workflow stage ${stage}`);
    positions.set(stage, index);
  }
  for (const [index, need] of needs.entries()) {
    for (const dependency of need.after ?? []) {
      const dependencyIndex = positions.get(dependency);
      if (dependencyIndex === undefined) {
        throw new Error(
          `Workflow stage ${need.stage ?? index} depends on unknown stage ${dependency}`,
        );
      }
      if (dependencyIndex >= index) {
        throw new Error(
          `Workflow stage ${need.stage ?? index} must appear after its dependency ${dependency}`,
        );
      }
    }
  }
}

function actionMatchesContext(
  action: SiteActionDefinition,
  requestedContext: string | undefined,
): boolean {
  if (requestedContext === undefined) return true;
  if (action.contexts === undefined || action.contexts.length === 0) return false;
  const requested = contextTokens(requestedContext);
  if (requested.length === 0) {
    return action.contexts.some(
      (context) => context.trim().toLowerCase() === requestedContext.trim().toLowerCase(),
    );
  }
  return action.contexts.some((context) => {
    const available = new Set(contextTokens(context));
    return requested.some((token) => available.has(token));
  });
}

const CONTEXT_STOP_WORDS = new Set([
  "a",
  "an",
  "current",
  "each",
  "every",
  "from",
  "in",
  "individual",
  "item",
  "items",
  "on",
  "page",
  "pages",
  "site",
  "the",
]);

function contextTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !CONTEXT_STOP_WORDS.has(token));
}

function filterByIntentVerb(ranked: RankedCapability[], query: string): RankedCapability[] {
  const verb = bindingVerbsIn(query)[0];
  if (verb === undefined) return ranked;
  return ranked.filter((entry) => {
    if (splitIdent(entry.summary.name)[0] === verb) return true;
    return (entry.summary.aliases ?? []).some((alias) => splitIdent(alias).includes(verb));
  });
}

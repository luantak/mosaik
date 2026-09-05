import { composeTask, type ComposeRequest, type ComposeResult } from "./compose.js";
import { getCapability, listCapabilities, searchCapabilities } from "./lookup.js";
import type { SiteActionRegistry } from "./lookup.js";
import { planTask, type CompositionPlan } from "./plan.js";
import { normalizeSiteId } from "./site.js";
import type { SiteActionSummary } from "./types.js";

export interface CompositionTools {
  list(siteId: string): Promise<SiteActionSummary[]>;
  search(siteId: string, intent: string): Promise<SiteActionSummary[]>;
  get(actionId: string): Promise<SiteActionSummary | undefined>;
  plan(request: {
    siteId: string;
    task: string;
    needs: ComposeRequest["needs"];
  }): Promise<CompositionPlan>;
  compose(request: ComposeRequest): Promise<ComposeResult>;
}

export function createCompositionTools(registry: SiteActionRegistry): CompositionTools {
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
      const normalized = inspect(siteId);
      return listCapabilities(registry, normalized);
    },
    async search(siteId, intent) {
      const normalized = inspect(siteId);
      return searchCapabilities(registry, normalized, intent);
    },
    async get(actionId) {
      return getCapability(registry, actionId);
    },
    async plan(request) {
      inspect(request.siteId);
      return planTask(registry, request);
    },
    async compose(request) {
      requireInspected(request.siteId);
      return composeTask(registry, request);
    },
  };
}

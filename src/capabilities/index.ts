import {
  getCapability,
  listCapabilities,
  searchCapabilities,
  type SiteActionRegistry,
} from "./lookup.js";

export { compileSiteAction, defineAction, type CallableSiteAction } from "./define.js";
export {
  COMPOSITION_STEPS,
  composeTask,
  generateCompositionSource,
  type CapabilityNeed,
  type ComposeMetrics,
  type ComposeRequest,
  type ComposeResult,
  type CompositionPlan,
  type CompositionStep,
} from "./compose.js";
export { createCompositionTools, type CompositionTools } from "./contract.js";
export {
  createActionDiscoverySession,
  defaultActionId,
  parseTerminalActionDiscovery,
  type ActionDiscoveryDraft,
  type ActionDiscoverySession,
  type TerminalActionDiscovery,
} from "./action-discovery.js";
export {
  assertMosaikAutomation,
  createCompositionSession,
  parseTerminalComposition,
  unwrapCodeModeValue,
  type ComposedAutomationView,
  type CompositionSession,
  type TerminalComposition,
} from "./code-mode.js";
export { matchNeed, normalizeCapabilityNeed, planTask, type PlanMatch } from "./plan.js";
export {
  createMemoryRegistry,
  getCapability,
  listCapabilities,
  rankCapabilities,
  searchCapabilities,
  toSummary,
  type ActionVersionUpdate,
  type SiteActionRegistry,
} from "./lookup.js";
export { applyActionPatches, siteActionAsAutomation } from "./repair.js";
export {
  assertSiteCapability,
  classifyActionGranularity,
  bindingVerbsIn,
  measureLearnedGranularity,
  splitIdent,
  type ActionGranularity,
  type GranularityReport,
  type GranularityTaskRecord,
} from "./granularity.js";
export {
  assignCompatibilityVersions,
  classifyActionChange,
  formatCompatibility,
  type ActionChangeKind,
} from "./compatibility.js";
export {
  actionInterfacesCompatible,
  array,
  boolean,
  coerceExtracted,
  coerceValue,
  formatSignature,
  formatType,
  number,
  object,
  optional,
  productRef,
  schemasEqual,
  string,
  validateObject,
  validateSchemaMap,
  validateValue,
  type ArrayType,
  type BooleanType,
  type InferActionSchema,
  type InferActionType,
  type NumberType,
  type ObjectType,
  type StringType,
} from "./schema.js";
export { normalizeSiteId } from "./site.js";
export { recordSuccessfulSiteActionReuse } from "./reuse.js";
export type {
  ActionImplementation,
  ActionSchema,
  ActionType,
  SiteActionDefinition,
  SiteActionSummary,
} from "./types.js";

export const capabilities = {
  list: (registry: SiteActionRegistry, siteId: string) => listCapabilities(registry, siteId),
  search: (registry: SiteActionRegistry, siteId: string, intent: string) =>
    searchCapabilities(registry, siteId, intent),
  get: (registry: SiteActionRegistry, actionId: string) => getCapability(registry, actionId),
};

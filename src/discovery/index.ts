export {
  QUOTES_HOME,
  QUOTES_TASK,
  discoverQuotesWorkflow,
  quotesDiscoveryRequest,
} from "./quotes.js";
export { addDraftStep, emptyDraft, removeDraftStep, updateDraftStep } from "./draft.js";
export {
  classifyLocatorProvenance,
  countLocatorProvenance,
  inferFromShape,
  type LocatorProvenance,
  type LocatorProvenanceCounts,
} from "./provenance.js";
export {
  isCoarseExtractLocator,
  validateDraftIntegrity,
  validateDraftLocatorsOnPage,
  type DraftValidationError,
  type DraftValidationResult,
} from "./draft-integrity.js";
export { effectiveGoal, evaluateGoal, goalCheck, type GoalCheck } from "./goal.js";
export {
  parseTerminalDiscovery,
  proposalFromTerminal,
  type TerminalDiscovery,
  type TerminalDiscoveryRefusal,
  type TerminalDiscoveryResult,
} from "./result.js";
export {
  createDiscoveryTools,
  sessionMetrics,
  type DiscoveryToolContext,
  type DiscoveryTools,
  type ExploreResult,
  type LocatorTestResult,
  type ReadTextResult,
} from "./tools.js";
export {
  DEFAULT_DISCOVERY_CONSTRAINTS,
  type DiscoveryConstraints,
  type DiscoveryDraft,
  type DiscoveryGoal,
  type DiscoveryMetrics,
  type DiscoveryOutcome,
  type DiscoveryProposal,
  type DiscoveryRequest,
  type DiscoveryStepType,
} from "./types.js";

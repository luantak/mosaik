export { createPlaywrightHost, createStubHost } from "./host.js";
export { runAutomation } from "./run.js";
export { executeComposedAutomation, transpileAutomation } from "./sandbox.js";
export { referencedActions, validateAutomation } from "./validate.js";
export {
  bindAutomationDependencies,
  formatDependencies,
  formatDependency,
  automationDependencies,
  AutomationDependencyError,
  resolveAutomationActions,
} from "./dependencies.js";
export {
  formatRepairFlightKey,
  RepairFlightCoordinator,
  sharedRepairFlights,
} from "./repair-flight.js";
export {
  HostActionError,
  AutomationValidationError,
  type ActionHost,
  type ComposedAutomation,
  type AutomationDependency,
  type AutomationExecutionResult,
  type AutomationOutputFile,
  type RepairCoordinationMetrics,
  type SharedActionRepairRecovery,
} from "./types.js";
export type { RepairFlightKey, SharedRepairOutcome } from "./repair-flight.js";

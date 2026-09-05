export { emitActionSource, parseActionSource } from "./action-source.js";
export {
  assertImportsStayInLibrary,
  parseAutomationImports,
  referencedImportedActions,
  referencedImportedAutomations,
  stripAutomationImports,
  type AutomationImport,
} from "./automation-imports.js";
export {
  resolveAutomationSourceForExecution,
  type ResolvedAutomationSource,
} from "./resolve-automation.js";
export {
  actionMetaDirectory,
  actionMetaPath,
  actionSourceDirectory,
  actionSourcePath,
  decodeLibraryId,
  encodeLibraryId,
  automationImportPath,
  automationMetaPath,
  automationSourcePath,
  relativeAutomationImportPath,
} from "./paths.js";
export * as actionsApi from "./actions-api.js";
export { defineAutomation } from "./automations-api.js";
export type {
  AutomationContext,
  AutomationHandler,
  AutomationDownloadedFile,
  AutomationDownloadRequest,
  AutomationOutputFile,
} from "./automations-api.js";

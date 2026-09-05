export { captureFailureArtifacts } from "./artifacts.js";
export { withBrowser, withIsolatedContext } from "./browser.js";
export {
  DEFAULT_STEP_TIMEOUT_MS,
  executeAutomation,
  executeStep,
  replayPrerequisites,
  type AutomationRunOptions,
  type AutomationRunResult,
} from "./execute.js";
export { startFixtureServer, type FixtureRoute, type FixtureServer } from "./fixtures.js";
export {
  browserSessionEnvironment,
  connectBrowserSessionOverCdp,
  ephemeralSession,
  isBrowserSession,
  openAgentBrowser,
  openBrowserSession,
  openInteractiveBrowserSession,
  MOSAIK_CDP_WS_URL_ENV,
  type BrowserSession,
  type BrowserSessionOptions,
  type InteractiveBrowserSession,
} from "./session.js";
export { locatorLabel, resolveLocator } from "./locators.js";
export {
  collectDegradedNodes,
  collectTextTargets,
  conservativeCssSelector,
  isConservativeCss,
  isEligibleDegraded,
  refineTextTargets,
  PAGE_SIGNAL_INIT,
  type DegradedNodeCandidate,
  type ExtractGranularityEvidence,
} from "./degraded.js";
export {
  collectOverview,
  formatOverviewText,
  toPageSnapshot,
  type InteractiveElement,
  type PageOverview,
  type PageSnapshot,
} from "./overview.js";

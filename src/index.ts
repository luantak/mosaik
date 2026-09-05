export {
  composeAndRun,
  DEFAULT_COMPOSITION_BUDGETS,
  DEFAULT_COMPOSITION_SAFETY,
} from "./composition/index.js";
export { DshCapabilityCompositionAgent } from "./agents/dsh/composition-agent.js";
export { DshReusableActionDiscoveryAgent } from "./agents/dsh/action-agent.js";
export { DshAuthSuccessAgent } from "./agents/dsh/auth-agent.js";
export {
  authAutomationId,
  authAutomationStep,
  buildAuthAutomation,
  createProfileCredentialPrompter,
  createTerminalCredentialPrompter,
  describeAuthSuccessCondition,
  discoverAuthChallenge,
  inferAuthSuccessCondition,
  loginWithBrowserSession,
  matchesAuthSuccessCondition,
  PROFILE_CREDENTIALS_FILENAME,
  profileCredentialsPath,
  parseAuthAutomation,
  type AuthChallenge,
  type AuthAutomation,
  type AuthAutomationField,
  type AuthAutomationStep,
  type AuthField,
  type AuthFieldKind,
  type AuthSuccessAgent,
  type AuthSuccessAgentDecision,
  type AuthSuccessAgentRequest,
  type AuthSuccessCandidate,
  type AuthSuccessCondition,
  type AuthSuccessMarker,
  type CredentialPrompter,
  type LoginOptions,
  type LoginResult,
} from "./auth/index.js";
export {
  connectBrowserSessionOverCdp,
  openBrowserSession,
  openInteractiveBrowserSession,
  type BrowserSession,
  type BrowserSessionOptions,
  type InteractiveBrowserSession,
} from "./runtime/session.js";
export {
  openKernelBrowserSession,
  type KernelBrowserSession,
  type KernelBrowserSessionOptions,
} from "./kernel/browser-session.js";
export {
  getKernelHostedLoginStatus,
  requireAuthenticatedKernelProfile,
  startKernelHostedLogin,
  type KernelAuthConnectionClient,
  type KernelHostedLoginRequest,
  type KernelHostedLoginStart,
  type KernelHostedLoginStatus,
} from "./kernel/hosted-login.js";
export type {
  RepairAgent,
  RepairProposal,
  AgentBudgets,
  CapabilityCompositionAgent,
  CapabilityCompositionRequest,
  CapabilityCompositionResult,
  CompositionProgressEvent,
  CompositionRunOptions,
  CompositionMetrics,
  CompositionSafetyConstraints,
  ReusableActionDiscoveryAgent,
  ReusableActionDiscoveryRequest,
  ReusableActionDiscoveryResult,
} from "./agents/types.js";
export { createMosaik, MosaikExecutionError, type Mosaik, type MosaikOptions } from "./mosaik.js";

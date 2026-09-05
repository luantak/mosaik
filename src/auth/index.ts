export { discoverAuthChallenge } from "./discovery.js";
export {
  authAutomationId,
  authAutomationStep,
  buildAuthAutomation,
  parseAuthAutomation,
} from "./automation.js";
export {
  createProfileCredentialPrompter,
  PROFILE_CREDENTIALS_FILENAME,
  profileCredentialsPath,
} from "./credentials.js";
export { loginWithBrowserSession } from "./login.js";
export { localBrowserProfileDirectory } from "./profile.js";
export { applySavedAuthentication, findAuthAutomationForUrl } from "./session.js";
export { createTerminalCredentialPrompter } from "./terminal.js";
export {
  describeAuthSuccessCondition,
  inferAuthSuccessCondition,
  matchesAuthSuccessCondition,
} from "./success.js";
export type {
  AuthChallenge,
  AuthAutomation,
  AuthAutomationField,
  AuthAutomationStep,
  AuthField,
  AuthFieldKind,
  AuthSuccessAgent,
  AuthSuccessAgentDecision,
  AuthSuccessAgentRequest,
  AuthSuccessCandidate,
  AuthSuccessCondition,
  AuthSuccessMarker,
  CredentialPrompter,
  LoginOptions,
  LoginResult,
} from "./types.js";

export {
  findCandidates,
  type CandidateEvidence,
  type LocatorCandidate,
  type LocatorSource,
} from "./candidates.js";
export {
  assessExactNameIdentity,
  assessRoleCompatibility,
  assessScopeCompatibility,
  locatorDeclaredRole,
  locatorName,
  type CompatibilityResult,
} from "./compatibility.js";
export { decideCandidates, isAllowedPatch, type CandidateDecision } from "./decision.js";
export {
  mayValidateStepLive,
  repairPolicyFor,
  type RepairAutonomy,
  type RepairPolicy,
} from "./policy.js";
export { similarity } from "./similarity.js";

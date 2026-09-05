import type { LocatorDefinition, Step } from "../core/index.js";
import { hasLocator, scopesEqual } from "../core/index.js";
import type { LocatorCandidate } from "./candidates.js";
import { locatorDeclaredRole, locatorName } from "./compatibility.js";
import { namesEqual } from "./similarity.js";

/**
 * Authoritative deterministic eligibility.
 * `eligible` means every mandatory compatibility, scope, uniqueness, and
 * ambiguity check already passed. Evidence fields on the candidate explain
 * that decision; they are not extra gates for the model to re-apply.
 */
export type CandidateDecision =
  | {
      status: "eligible";
      candidate: LocatorCandidate;
    }
  | {
      status: "ambiguous";
      candidates: LocatorCandidate[];
      reason: string;
    }
  | {
      status: "none";
      reason: string;
    };

const STRENGTH_GAP = 0.3;
const IDENTITY_FLOOR = 0.5;

export function decideCandidates(step: Step, candidates: LocatorCandidate[]): CandidateDecision {
  const plausible = candidates.filter((candidate) => isPlausible(step, candidate));
  if (plausible.length === 0) {
    return { status: "none", reason: "No compatible unique candidate remains" };
  }

  const exact = plausible.filter(
    (candidate) => candidate.evidence.exactNameMatch || candidate.evidence.exactLabelMatch === true,
  );
  const pool = exact.length > 0 ? exact : plausible;
  if (pool.length === 1) {
    const candidate = pool[0];
    if (candidate !== undefined) return { status: "eligible", candidate };
  }

  if (step.type === "click" && exact.length === 0) {
    return {
      status: "ambiguous",
      candidates: pool,
      reason: "Multiple distinct click targets remain equally plausible",
    };
  }

  const ranked = [...pool].sort((left, right) => identityStrength(right) - identityStrength(left));
  const best = ranked[0];
  if (best === undefined) {
    return { status: "none", reason: "No compatible unique candidate remains" };
  }
  const tied = ranked.filter(
    (candidate) => identityStrength(best) - identityStrength(candidate) < STRENGTH_GAP,
  );
  if (tied.length > 1) {
    return {
      status: "ambiguous",
      candidates: tied,
      reason: "Multiple distinct candidates remain equally plausible",
    };
  }
  return { status: "eligible", candidate: best };
}

export function isAllowedPatch(
  patched: LocatorDefinition,
  eligible: LocatorCandidate,
  step: Step,
): boolean {
  if (locatorsEquivalent(patched, eligible.locator)) return true;
  const patchedName = locatorName(patched);
  const eligibleName = locatorName(eligible.locator);
  if (hasLocator(step) && step.locator.within !== undefined) {
    if (!scopesEqual(step.locator.within, patched.within)) return false;
  }
  if (patchedName === undefined || eligibleName === undefined) return false;
  if (!namesEqual(patchedName, eligibleName)) return false;
  const patchedRole = locatorDeclaredRole(patched);
  if (patchedRole === undefined) return true;
  const eligibleRole = locatorDeclaredRole(eligible.locator);
  if (eligibleRole !== undefined) return patchedRole === eligibleRole;
  return step.type !== "click" || patchedRole === "button" || patchedRole === "link";
}

export function identityStrength(candidate: LocatorCandidate): number {
  if (candidate.evidence.exactNameMatch || candidate.evidence.exactLabelMatch === true) return 1;
  const name = candidate.evidence.nameSimilarity ?? 0;
  const label = candidate.evidence.labelSimilarity ?? 0;
  return Math.max(name, label) + (candidate.evidence.structuralContextMatch === true ? 0.3 : 0);
}

function isPlausible(step: Step, candidate: LocatorCandidate): boolean {
  if (candidate.source === "degraded-dom") return false;
  if (!candidate.evidence.roleCompatible) return false;
  if (
    hasLocator(step) &&
    step.locator.within !== undefined &&
    !candidate.evidence.scopeCompatible
  ) {
    return false;
  }
  if (!candidate.evidence.unique || !candidate.evidence.visible || !candidate.evidence.enabled) {
    return false;
  }
  if (step.type === "click") return true;
  if (candidate.evidence.exactNameMatch || candidate.evidence.exactLabelMatch === true) return true;
  const name = candidate.evidence.nameSimilarity ?? 0;
  const label = candidate.evidence.labelSimilarity ?? 0;
  return name >= IDENTITY_FLOOR || label >= IDENTITY_FLOOR;
}

function locatorsEquivalent(left: LocatorDefinition, right: LocatorDefinition): boolean {
  return JSON.stringify(normalizeLocator(left)) === JSON.stringify(normalizeLocator(right));
}

function normalizeLocator(locator: LocatorDefinition): LocatorDefinition {
  const exact =
    locator.strategy === "test-id" || locator.strategy === "css"
      ? {}
      : { exact: locator.exact !== false };
  return {
    ...locator,
    ...exact,
  };
}

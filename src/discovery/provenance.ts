import type { LocatorDefinition, Step } from "../core/index.js";
import { hasLocator } from "../core/index.js";
import { isConservativeCss } from "../runtime/degraded.js";
import type { LocatorCandidate, LocatorSource } from "../repair/candidates.js";

export type LocatorProvenance =
  | "semantic"
  | "scoped-semantic"
  | "test-id"
  | "degraded-dom-css"
  | "manual-css";

export interface LocatorProvenanceCounts {
  semantic: number;
  scopedSemantic: number;
  testId: number;
  degradedCss: number;
  manualCss: number;
}

export function classifyLocatorProvenance(
  locator: LocatorDefinition,
  offered: LocatorCandidate[] = [],
): LocatorProvenance {
  const match = offered.find((candidate) => locatorsEqual(candidate.locator, locator));
  if (match?.source !== undefined) return provenanceFromSource(match.source, locator);
  return inferFromShape(locator);
}

export function inferFromShape(locator: LocatorDefinition): LocatorProvenance {
  if (locator.strategy === "test-id") return "test-id";
  if (locator.strategy === "css") {
    return isConservativeCss(locator.selector) ? "degraded-dom-css" : "manual-css";
  }
  if (locator.within !== undefined) return "scoped-semantic";
  return "semantic";
}

export function countLocatorProvenance(steps: Step[]): LocatorProvenanceCounts {
  const counts: LocatorProvenanceCounts = {
    semantic: 0,
    scopedSemantic: 0,
    testId: 0,
    degradedCss: 0,
    manualCss: 0,
  };
  for (const step of steps) {
    if (!hasLocator(step)) continue;
    const source = inferFromShape(step.locator);
    if (source === "semantic") counts.semantic += 1;
    else if (source === "scoped-semantic") counts.scopedSemantic += 1;
    else if (source === "test-id") counts.testId += 1;
    else if (source === "degraded-dom-css") counts.degradedCss += 1;
    else counts.manualCss += 1;
  }
  return counts;
}

function provenanceFromSource(
  source: LocatorSource,
  locator: LocatorDefinition,
): LocatorProvenance {
  if (source === "degraded-dom") return "degraded-dom-css";
  if (source === "test-id") return "test-id";
  if (source === "scoped-semantic") return "scoped-semantic";
  if (locator.strategy === "css") return inferFromShape(locator);
  return "semantic";
}

function locatorsEqual(left: LocatorDefinition, right: LocatorDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

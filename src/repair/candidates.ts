import type { LocatorContext, LocatorDefinition, LocatorScope, Step } from "../core/index.js";
import { hasLocator, scopesEqual } from "../core/index.js";
import {
  collectDegradedNodes,
  collectTextTargets,
  conservativeLocator,
  type ExtractGranularityEvidence,
} from "../runtime/degraded.js";
import { resolveLocator } from "../runtime/locators.js";
import type { InteractiveElement } from "../runtime/overview.js";
import { assessRoleCompatibility, locatorName } from "./compatibility.js";
import { namesEqual, similarity } from "./similarity.js";

export type LocatorSource = "semantic" | "scoped-semantic" | "test-id" | "degraded-dom";

export interface CandidateEvidence {
  roleCompatible: boolean;
  exactNameMatch: boolean;
  exactLabelMatch: boolean;
  nameSimilarity: number;
  labelSimilarity: number;
  unique: boolean;
  sameRole: boolean;
  sameStrategy: boolean;
  matchCount: number;
  visible: boolean;
  enabled: boolean;
  structuralContextMatch: boolean;
  scopeCompatible: boolean;
  scopeMatch?: {
    expected?: LocatorScope;
    actual?: LocatorScope;
  };
  context?: LocatorContext;
  landmark?: string;
  formName?: string;
  landmarks?: string[];
  formNames?: string[];
}

export interface LocatorCandidate {
  locator: LocatorDefinition;
  evidence: CandidateEvidence;
  source?: LocatorSource;
  extractEvidence?: ExtractGranularityEvidence;
}

export async function findCandidates(
  page: import("playwright").Page,
  step: Step,
  interactive: InteractiveElement[],
  options: { includeDegraded?: boolean; extractHint?: string } = {},
): Promise<LocatorCandidate[]> {
  if (!hasLocator(step)) return [];
  const failed = step.locator;
  const failedName = locatorName(failed);
  const failedRole = failed.strategy === "role" ? failed.role : undefined;
  const byKey = new Map<string, LocatorCandidate>();
  const includeDegraded = options.includeDegraded === true;

  for (const element of interactive) {
    if (!element.visible) continue;
    const proposed = proposeLocator(element);
    if (proposed === undefined) continue;
    const key = JSON.stringify(proposed);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.evidence = mergeContext(existing.evidence, element);
      continue;
    }

    const matchCount = await resolveLocator(page, proposed).count();
    const nameSimilarity =
      failedName === undefined || element.name === undefined
        ? 0
        : similarity(failedName, element.name);
    const labelSimilarity =
      failed.strategy === "label" && element.label !== undefined
        ? similarity(failed.label, element.label)
        : element.label !== undefined && failedName !== undefined
          ? similarity(failedName, element.label)
          : 0;
    const roleCompatible = assessRoleCompatibility(step, element.role).compatible;
    const exactNameMatch =
      failedName !== undefined &&
      element.name !== undefined &&
      namesEqual(failedName, element.name);
    const exactLabelMatch =
      failedName !== undefined &&
      element.label !== undefined &&
      namesEqual(failedName, element.label);
    const actualScope = proposed.within;
    const scopeCompatible = failed.within === undefined || scopesEqual(failed.within, actualScope);

    byKey.set(key, {
      locator: proposed,
      source: sourceOf(proposed),
      evidence: mergeContext(
        {
          roleCompatible,
          exactNameMatch,
          exactLabelMatch,
          nameSimilarity: roundEvidence(nameSimilarity),
          labelSimilarity: roundEvidence(labelSimilarity),
          unique: matchCount === 1,
          sameRole: failedRole !== undefined && element.role === failedRole,
          sameStrategy: proposed.strategy === failed.strategy,
          matchCount,
          visible: element.visible,
          enabled: element.enabled,
          structuralContextMatch: scopesEqual(failed.within, proposed.within),
          scopeCompatible,
          ...(failed.within === undefined && actualScope === undefined
            ? {}
            : {
                scopeMatch: {
                  ...(failed.within === undefined ? {} : { expected: failed.within }),
                  ...(actualScope === undefined ? {} : { actual: actualScope }),
                },
              }),
        },
        element,
      ),
    });
  }

  if (includeDegraded) {
    const degraded = await collectDegradedNodes(page);
    for (const node of degraded) {
      const proposed = conservativeLocator(node);
      if (proposed === undefined) continue;
      const key = JSON.stringify(proposed);
      if (byKey.has(key)) continue;
      const matchCount = await resolveLocator(page, proposed).count();
      byKey.set(key, {
        locator: proposed,
        source: proposed.strategy === "test-id" ? "test-id" : "degraded-dom",
        evidence: {
          roleCompatible: true,
          exactNameMatch: false,
          exactLabelMatch: false,
          nameSimilarity: 0,
          labelSimilarity: 0,
          unique: matchCount === 1,
          sameRole: false,
          sameStrategy: failed.strategy === proposed.strategy,
          matchCount,
          visible: node.signals.visible,
          enabled: true,
          structuralContextMatch: false,
          scopeCompatible: true,
        },
      });
    }
  }

  const extractHint =
    options.extractHint ?? (step.type === "extract-text" ? failedName : undefined);
  if (step.type === "extract-text" || extractHint !== undefined) {
    const targets = await collectTextTargets(page, extractHint);
    for (const target of targets) {
      const key = JSON.stringify(target.locator);
      const existing = byKey.get(key);
      if (existing !== undefined) {
        if (existing.extractEvidence === undefined) existing.extractEvidence = target.evidence;
        continue;
      }
      const matchCount = await resolveLocator(page, target.locator).count();
      byKey.set(key, {
        locator: target.locator,
        source: sourceOf(target.locator),
        extractEvidence: target.evidence,
        evidence: {
          roleCompatible: true,
          exactNameMatch: failedName !== undefined && namesEqual(failedName, target.evidence.text),
          exactLabelMatch: false,
          nameSimilarity:
            failedName === undefined ? 0 : similarity(failedName, target.evidence.text),
          labelSimilarity: 0,
          unique: matchCount === 1,
          sameRole: false,
          sameStrategy: failed.strategy === target.locator.strategy,
          matchCount,
          visible: true,
          enabled: true,
          structuralContextMatch: false,
          scopeCompatible: true,
        },
      });
    }
  }

  return [...byKey.values()].sort((left, right) => {
    const sourceRank = rankSource(left.source) - rankSource(right.source);
    if (sourceRank !== 0) return sourceRank;
    const leftGrain =
      left.extractEvidence === undefined ? 3 : rankExtract(left.extractEvidence.granularity);
    const rightGrain =
      right.extractEvidence === undefined ? 3 : rankExtract(right.extractEvidence.granularity);
    return leftGrain - rightGrain;
  });
}

function sourceOf(locator: LocatorDefinition): LocatorSource {
  if (locator.strategy === "test-id") return "test-id";
  if (locator.strategy === "css") return "degraded-dom";
  if (locator.within !== undefined) return "scoped-semantic";
  return "semantic";
}

function rankSource(source: LocatorSource | undefined): number {
  if (source === "semantic" || source === "scoped-semantic") return 0;
  if (source === "test-id") return 1;
  return 2;
}

function rankExtract(value: ExtractGranularityEvidence["granularity"]): number {
  if (value === "leaf") return 0;
  if (value === "small-container") return 1;
  return 2;
}

function proposeLocator(element: InteractiveElement): LocatorDefinition | undefined {
  const within = scopeFor(element);
  const scoped = <T extends LocatorDefinition>(locator: T): T =>
    within === undefined ? locator : { ...locator, within };

  if (element.role !== undefined && element.name !== undefined && element.name.length > 0) {
    return scoped({ strategy: "role", role: element.role, name: element.name, exact: true });
  }
  if (element.label !== undefined && element.label.length > 0) {
    return scoped({ strategy: "label", label: element.label, exact: true });
  }
  if (element.testId !== undefined) {
    return scoped({ strategy: "test-id", testId: element.testId });
  }
  if (element.text !== undefined && element.text.length > 0) {
    return scoped({ strategy: "text", text: element.text, exact: true });
  }
  return undefined;
}

function scopeFor(element: InteractiveElement): LocatorScope | undefined {
  if (element.formName !== undefined && element.formName.length > 0) {
    return { kind: "form", name: element.formName };
  }
  const landmark = parseLandmark(element.landmark);
  if (landmark?.role === undefined || landmark.name === undefined) return undefined;
  if (landmark.role.length === 0 || landmark.name.length === 0) return undefined;
  return { kind: "landmark", role: landmark.role, name: landmark.name };
}

function elementContext(element: InteractiveElement): LocatorContext | undefined {
  const ancestorLabels = uniqueStrings([
    ...(element.heading === undefined ? [] : [element.heading]),
    ...(element.formName === undefined ? [] : [element.formName]),
  ]);
  const landmark = parseLandmark(element.landmark);
  const form =
    element.formName === undefined
      ? undefined
      : { name: element.formName, accessibleName: element.formName };
  if (form === undefined && landmark === undefined && ancestorLabels.length === 0) {
    return undefined;
  }
  return {
    ...(form === undefined ? {} : { form }),
    ...(landmark === undefined ? {} : { landmark }),
    ...(ancestorLabels.length === 0 ? {} : { ancestorLabels }),
  };
}

function parseLandmark(value: string | undefined): LocatorContext["landmark"] {
  if (value === undefined || value.length === 0) return undefined;
  const separator = value.indexOf(":");
  return separator === -1
    ? { role: value }
    : { role: value.slice(0, separator), name: value.slice(separator + 1) };
}

function mergeContext(evidence: CandidateEvidence, element: InteractiveElement): CandidateEvidence {
  const formNames = uniqueStrings([
    ...(evidence.formNames ?? []),
    ...(evidence.formName === undefined ? [] : [evidence.formName]),
    ...(element.formName === undefined ? [] : [element.formName]),
  ]);
  const landmarks = uniqueStrings([
    ...(evidence.landmarks ?? []),
    ...(evidence.landmark === undefined ? [] : [evidence.landmark]),
    ...(element.landmark === undefined ? [] : [element.landmark]),
  ]);
  const context = elementContext(element) ?? evidence.context;
  return {
    ...evidence,
    ...(formNames[0] === undefined ? {} : { formName: formNames[0] }),
    ...(formNames.length > 1 ? { formNames } : {}),
    ...(landmarks[0] === undefined ? {} : { landmark: landmarks[0] }),
    ...(landmarks.length > 1 ? { landmarks } : {}),
    ...(context === undefined ? {} : { context }),
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function roundEvidence(value: number): number {
  return Math.round(value * 100) / 100;
}

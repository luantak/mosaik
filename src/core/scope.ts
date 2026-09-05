import type { LocatorDefinition, LocatorScope } from "./types.js";
import { hasLocator, type Step } from "./types.js";

export function scopesEqual(
  left: LocatorScope | undefined,
  right: LocatorScope | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "container" && right.kind === "container")
    return JSON.stringify(left) === JSON.stringify(right);
  if (left.kind === "form" && right.kind === "form") {
    return normalize(left.name) === normalize(right.name);
  }
  if (left.kind === "landmark" && right.kind === "landmark") {
    if (left.role !== right.role) return false;
    if (left.name === undefined || right.name === undefined) {
      return left.name === right.name;
    }
    return normalize(left.name) === normalize(right.name);
  }
  return false;
}

export function scopeLabel(scope: LocatorScope): string {
  if (scope.kind === "container") return `container=${JSON.stringify(scope.locator)}`;
  if (scope.kind === "form") return `form "${scope.name}"`;
  return scope.name === undefined
    ? `landmark ${scope.role}`
    : `landmark ${scope.role} "${scope.name}"`;
}

export function locatorScope(locator: LocatorDefinition): LocatorScope | undefined {
  return locator.within;
}

export function bindLocatorScope(
  original: LocatorDefinition,
  proposed: LocatorDefinition,
): { locator: LocatorDefinition; changed: boolean } | { rejected: true; reason: string } {
  if (original.within === undefined) {
    if (proposed.within === undefined) return { locator: proposed, changed: false };
    const { within: _dropped, ...rest } = proposed;
    return { locator: rest, changed: true };
  }
  if (proposed.within === undefined) {
    return { locator: { ...proposed, within: original.within }, changed: false };
  }
  if (scopesEqual(original.within, proposed.within)) {
    return { locator: proposed, changed: false };
  }
  return {
    rejected: true,
    reason: `scope-change: ${scopeLabel(original.within)} -> ${scopeLabel(proposed.within)}`,
  };
}

export function stepHasScope(
  step: Step,
): step is Step & { locator: LocatorDefinition & { within: LocatorScope } } {
  return hasLocator(step) && step.locator.within !== undefined;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

import { compileSiteAction } from "./define.js";
import { fingerprint } from "../evidence/capture.js";
import type { Condition } from "../core/types.js";
import type { ActionImplementation, SiteActionDefinition } from "./types.js";

export type StateImplementationPatch = {
  type: "add-implementation";
  implementation: ActionImplementation;
};
/** Proves disjointness only for explicit unequal values on the same observation. */
export function conditionsDisjoint(left: Condition, right: Condition): boolean {
  if (left.kind === "any")
    return left.conditions.every((child) => conditionsDisjoint(child, right));
  if (right.kind === "any")
    return right.conditions.every((child) => conditionsDisjoint(left, child));
  if (left.kind === "all") return left.conditions.some((child) => conditionsDisjoint(child, right));
  if (right.kind === "all")
    return right.conditions.some((child) => conditionsDisjoint(left, child));
  if (left.kind !== right.kind) return false;
  if (left.kind === "count" && right.kind === "count")
    return (
      (left.comparison ?? "equals") === "equals" &&
      (right.comparison ?? "equals") === "equals" &&
      fingerprint(left.locator) === fingerprint(right.locator) &&
      left.count !== right.count
    );
  if (left.kind === "url" && right.kind === "url")
    return (
      (left.comparison ?? "equals") === "equals" &&
      (right.comparison ?? "equals") === "equals" &&
      typeof left.value === "string" &&
      typeof right.value === "string" &&
      left.value !== right.value
    );
  if (
    (left.kind === "text" || left.kind === "attribute") &&
    (right.kind === "text" || right.kind === "attribute")
  )
    return (
      fingerprint(left.locator) === fingerprint(right.locator) &&
      left.name === right.name &&
      (left.comparison ?? "equals") === "equals" &&
      (right.comparison ?? "equals") === "equals" &&
      typeof left.value === "string" &&
      typeof right.value === "string" &&
      left.value !== right.value
    );
  return false;
}
export function addStateImplementation(
  action: SiteActionDefinition,
  patch: StateImplementationPatch,
): SiteActionDefinition {
  const previous = action.implementations ?? [
    { ...action.implementation, id: action.implementation.id ?? "default" },
  ];
  const next = patch.implementation;
  if (!next.id || !next.precondition || !next.completion)
    throw new Error(
      "New implementation requires an ID and explicit starting/completion conditions",
    );
  if (
    previous.some(
      (implementation) =>
        !implementation.precondition ||
        !conditionsDisjoint(implementation.precondition, next.precondition!),
    )
  )
    throw new Error("Cannot prove implementation conditions are disjoint");
  // State repair may change targets and the starting-state discriminator only.
  const shape = (implementation: ActionImplementation) => ({
    completion: implementation.completion,
    steps: implementation.steps.map((step) => {
      const copy = { ...step } as Record<string, unknown>;
      delete copy.locator;
      return copy;
    }),
  });
  if (
    !previous.some(
      (implementation) => fingerprint(shape(implementation)) === fingerprint(shape(next)),
    )
  )
    throw new Error(
      "State repair must preserve steps, inputs, outputs, safety, navigation and completion contract",
    );
  return compileSiteAction({
    ...action,
    implementations: [...previous, structuredClone(next)],
    version: action.version + 1,
    verification: "unverified",
  });
}

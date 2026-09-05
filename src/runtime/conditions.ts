import type { Page } from "playwright";
import { resolveStepValue, type Condition } from "../core/index.js";
import { resolveLocator } from "./locators.js";

export class ConditionError extends Error {
  constructor(
    public readonly type:
      | "condition-failed"
      | "unsupported-state"
      | "ambiguous-state"
      | "uncertain-outcome",
    message: string,
  ) {
    super(message);
  }
}
export type BeforeValues = Map<string, unknown>;

export async function observeCondition(
  page: Page,
  condition: Condition,
  inputs: Record<string, unknown>,
  before: BeforeValues = new Map(),
): Promise<boolean> {
  switch (condition.kind) {
    case "all":
    case "any": {
      const values = await Promise.all(
        condition.conditions.map((c) => observeCondition(page, c, inputs, before)),
      );
      return condition.kind === "all" ? values.every(Boolean) : values.some(Boolean);
    }
    case "url":
      return compare(page.url(), resolveStepValue(condition.value, inputs), condition.comparison);
    case "count": {
      const count = await resolveLocator(page, condition.locator, inputs).count();
      if (condition.comparison === "gte") return count >= condition.count;
      if (condition.comparison === "lte") return count <= condition.count;
      return count === condition.count;
    }
    case "visible":
    case "enabled": {
      const target = resolveLocator(page, condition.locator, inputs);
      if ((await target.count()) !== 1) return false;
      return (
        (condition.kind === "visible" ? await target.isVisible() : await target.isEnabled()) ===
        (condition.value ?? true)
      );
    }
    case "text":
    case "attribute":
    case "changed": {
      const target = resolveLocator(page, condition.locator, inputs);
      if ((await target.count()) !== 1) return false;
      const attr =
        condition.kind === "changed"
          ? condition.attribute
          : condition.kind === "attribute"
            ? condition.name
            : undefined;
      const value =
        attr === undefined
          ? await target.textContent({ timeout: 100 })
          : await target.getAttribute(attr, { timeout: 100 });
      if (condition.kind === "changed")
        return (
          before.has(JSON.stringify(condition)) && value !== before.get(JSON.stringify(condition))
        );
      return (
        value !== null &&
        compare(value, resolveStepValue(condition.value, inputs), condition.comparison)
      );
    }
  }
}
function compare(actual: string, expected: string, comparison?: "equals" | "contains"): boolean {
  return comparison === "contains" ? actual.includes(expected) : actual === expected;
}
export async function captureBefore(
  page: Page,
  condition: Condition | undefined,
  inputs: Record<string, unknown>,
  before: BeforeValues = new Map(),
): Promise<BeforeValues> {
  if (!condition) return before;
  if (condition.kind === "all" || condition.kind === "any") {
    for (const child of condition.conditions) await captureBefore(page, child, inputs, before);
  } else if (condition.kind === "changed") {
    const target = resolveLocator(page, condition.locator, inputs);
    if ((await target.count()) !== 1)
      throw new ConditionError("condition-failed", "Before-value target must be unique");
    before.set(
      JSON.stringify(condition),
      condition.attribute === undefined
        ? await target.textContent()
        : await target.getAttribute(condition.attribute),
    );
  }
  return before;
}
export async function waitCondition(
  page: Page,
  condition: Condition,
  inputs: Record<string, unknown>,
  timeoutMs: number,
  before: BeforeValues = new Map(),
): Promise<void> {
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 30_000);
  do {
    if (await observeCondition(page, condition, inputs, before)) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw new ConditionError("condition-failed", `Condition timed out: ${JSON.stringify(condition)}`);
}

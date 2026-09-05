import { validateLocator } from "../core/compile.js";
import { CompileError, type Condition } from "../core/index.js";
import type { ActionSchema } from "./types.js";

export function inputReferences(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  if ("kind" in value && value.kind === "input" && "key" in value && typeof value.key === "string")
    return [value.key];
  return Object.values(value).flatMap(inputReferences);
}
export function validateReferences(value: unknown, inputs: ActionSchema): void {
  for (const key of inputReferences(value)) {
    const parts = key.split(".");
    let schema = inputs[parts.shift()!];
    for (const part of parts)
      schema = schema?.type === "object" ? schema.properties[part] : undefined;
    if (schema === undefined || !["string", "number", "boolean"].includes(schema.type))
      throw new CompileError(`Invalid scalar input reference: ${key}`);
  }
}
export function validateCondition(condition: Condition | undefined, depth = 0): void {
  if (condition === undefined) return;
  if (depth > 8) throw new CompileError("Conditions may nest at most eight levels");
  if ("locator" in condition) validateLocator(condition.locator, "condition");
  if ("value" in condition && condition.kind !== "visible" && condition.kind !== "enabled") {
    const value = condition.value;
    if (
      typeof value !== "string" &&
      (!value ||
        typeof value !== "object" ||
        (value.kind !== "literal" && value.kind !== "input") ||
        (value.kind === "input"
          ? typeof value.key !== "string" || !value.key
          : typeof value.value !== "string"))
    )
      throw new CompileError("Invalid condition value");
  }
  switch (condition.kind) {
    case "all":
    case "any":
      if (
        !Array.isArray(condition.conditions) ||
        condition.conditions.length < 1 ||
        condition.conditions.length > 32
      )
        throw new CompileError("Conditions need 1 to 32 children");
      condition.conditions.forEach((c) => validateCondition(c, depth + 1));
      return;
    case "count":
      if (!Number.isSafeInteger(condition.count) || condition.count < 0)
        throw new CompileError(
          'Condition count must be a literal nonnegative integer, not an input reference or range. Use count:1, comparison:"gte" for a nonempty list; keep requested item limits in the automation',
        );
      if (
        condition.comparison !== undefined &&
        !["equals", "gte", "lte"].includes(condition.comparison)
      )
        throw new CompileError("Count comparison must be equals, gte, or lte");
      return;
    case "attribute":
      if (!condition.name) throw new CompileError("Attribute condition requires a name");
      return;
    case "url":
    case "text":
    case "visible":
    case "enabled":
    case "changed":
      return;
    default:
      throw new CompileError("Unknown condition kind");
  }
}

import { discoveryOperation } from "./discovery-operations.js";
import { bindLocator } from "../../runtime/locators.js";
import { isDeepStrictEqual } from "node:util";
import { parse, type Node } from "acorn";
import { stripAutomationTypes } from "../../automations/typescript.js";
import type { SiteActionDefinition } from "../../capabilities/types.js";

type Expression = Node & {
  name?: string;
  computed?: boolean;
  callee?: Expression;
  object?: Expression;
  property?: Expression;
  arguments?: Expression[];
  properties?: Expression[];
  key?: Expression;
  value?: unknown;
  kind?: string;
  method?: boolean;
};

/** Read-only observations or exact ordered receipts for a click workflow
 * can go directly to outcome review. This avoids replaying mutations merely to
 * hand off discovery. Task logic and unobserved calls still require execution. */
export function canCompleteFromDiscovery(
  source: string,
  actions: SiteActionDefinition[],
  observations: unknown[] = [],
): boolean {
  const byName = new Map(actions.map((action) => [action.name, action]));
  const called = new Set<string>();
  let simple = true;
  let mutable = false;
  const calls: Array<{ action: SiteActionDefinition; args: Record<string, unknown> | undefined }> =
    [];
  let file: Node;
  try {
    file = parse(stripAutomationTypes(source), { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return false;
  }
  const visit = (node: Expression): void => {
    if (
      [
        "IfStatement",
        "ForStatement",
        "ForOfStatement",
        "ForInStatement",
        "WhileStatement",
        "DoWhileStatement",
        "SwitchStatement",
        "TryStatement",
        "ConditionalExpression",
        "BinaryExpression",
        "LogicalExpression",
        "AssignmentExpression",
        "UpdateExpression",
        "NewExpression",
        "ThrowStatement",
      ].includes(node.type)
    )
      simple = false;
    if (node.type === "MemberExpression" && node.computed) simple = false;
    if (node.type === "CallExpression") {
      const expression = node.callee;
      if (expression?.type === "Identifier" && expression.name === "defineAutomation") {
        /* wrapper */
      } else {
        const name =
          expression?.type === "Identifier"
            ? expression.name
            : expression?.type === "MemberExpression" &&
                !expression.computed &&
                expression.object?.type === "MemberExpression" &&
                !expression.object.computed &&
                expression.object.property?.name === "actions"
              ? expression.property?.name
              : undefined;
        const action = name ? byName.get(name) : undefined;
        if (
          !action ||
          called.has(action.name) ||
          !["read-only", "browser-local"].includes(action.safety) ||
          !(action.implementations ?? [action.implementation]).every((implementation) =>
            implementation.steps.every(
              (step) =>
                step.type === "navigate" ||
                step.type === "click" ||
                step.type === "fill" ||
                step.type === "select" ||
                step.type === "extract-text" ||
                step.type === "extract-list",
            ),
          )
        )
          simple = false;
        if (action) {
          called.add(action.name);
          calls.push({ action, args: literalArguments(node.arguments ?? []) });
          if (action.safety !== "read-only") mutable = true;
        }
      }
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object" && typeof child.type === "string")
          visit(child as Expression);
      }
    }
  };
  visit(file);
  if (!simple || called.size === 0) return false;
  if (!mutable) return true;
  const receipts = observations.slice(-calls.length);
  if (receipts.length !== calls.length) return false;
  return calls.every(({ action, args }, index) => {
    const observation = receipts[index];
    if (!args || !observation || typeof observation !== "object") return false;
    const receipt = observation as Record<string, unknown>;
    const examples = (receipt.inputs ?? {}) as Record<string, unknown>;
    if (
      receipt.name !== action.name ||
      Object.keys(args).some((key) => !(key in action.inputs)) ||
      !isDeepStrictEqual(
        args,
        Object.fromEntries(
          Object.keys(action.inputs)
            .filter((key) => key in examples)
            .map((key) => [key, examples[key]]),
        ),
      )
    )
      return false;
    if (action.safety === "read-only") return true;
    if (Object.keys(action.outputs).length > 0) return false;
    try {
      return (action.implementations ?? [action.implementation]).every((implementation) =>
        Array.isArray(receipt.performedOperations)
          ? implementation.steps.every((step) => ["click", "fill", "select"].includes(step.type)) &&
            observedOperationsCover(
              receipt.performedOperations,
              implementation.steps.map((step) => discoveryOperation(step, args)),
            )
          : implementation.steps.every((step) => step.type === "click") &&
            isDeepStrictEqual(
              receipt.performedClicks,
              implementation.steps.map((step) =>
                step.type === "click" ? bindLocator(step.locator, args) : undefined,
              ),
            ),
      );
    } catch {
      return false;
    }
  });
}

function literalArguments(args: Expression[]): Record<string, unknown> | undefined {
  if (args[0]?.type === "Identifier" && args[0].name === "ctx") args = args.slice(1);
  if (args.length === 0) return {};
  if (args.length !== 1 || args[0]?.type !== "ObjectExpression") return undefined;
  const entries: Array<[string, unknown]> = [];
  for (const property of args[0].properties ?? []) {
    const value = property.value as Expression | undefined;
    const key = property.key?.type === "Identifier" ? property.key.name : property.key?.value;
    if (
      property.type !== "Property" ||
      property.computed ||
      property.method ||
      property.kind !== "init" ||
      typeof key !== "string" ||
      value?.type !== "Literal" ||
      !["string", "number", "boolean"].includes(typeof value.value)
    )
      return undefined;
    entries.push([key, value.value]);
  }
  return Object.fromEntries(entries);
}

// Discovery may open a tool panel before performing the saved operation. Those
// preceding clicks do not require the already performed operation to be replayed.
function observedOperationsCover(observed: unknown[], expected: unknown[]): boolean {
  if (expected.length === 0 || observed.length < expected.length) return false;
  const prefix = observed.slice(0, observed.length - expected.length);
  return (
    isDeepStrictEqual(observed.slice(-expected.length), expected) &&
    prefix.every(
      (operation) =>
        operation &&
        typeof operation === "object" &&
        "type" in operation &&
        operation.type === "click" &&
        !expected.some((step) => isDeepStrictEqual(step, operation)),
    )
  );
}

/** Incomplete receipts must never turn already performed edits into a fresh replay. */
export function discoveryHasPerformedMutations(
  actions: SiteActionDefinition[],
  observations: unknown[] = [],
): boolean {
  return observations.some((observation) => {
    if (!observation || typeof observation !== "object") return false;
    const receipt = observation as { name?: string; performedOperations?: unknown[] };
    return (
      (receipt.performedOperations?.length ?? 0) > 0 &&
      actions.some((action) => action.name === receipt.name && action.safety !== "read-only")
    );
  });
}

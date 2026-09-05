import type { Automation, LocatorDefinition, Step } from "./types.js";
import { stepValuePresent } from "./types.js";

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

export function compile(automation: Automation): Automation {
  if (automation.id.length === 0) throw new CompileError("Automation id is required");
  if (automation.actions.length === 0)
    throw new CompileError("Automation needs at least one action");

  const actionIds = new Set<string>();
  const stepIds = new Set<string>();
  const outputKeys = new Set<string>();

  for (const action of automation.actions) {
    if (action.id.length === 0) throw new CompileError("Action id is required");
    if (actionIds.has(action.id)) throw new CompileError(`Duplicate action id: ${action.id}`);
    actionIds.add(action.id);
    if (action.steps.length === 0) throw new CompileError(`Action ${action.id} has no steps`);

    for (const step of action.steps) {
      if (step.id.length === 0) throw new CompileError("Step id is required");
      if (stepIds.has(step.id)) throw new CompileError(`Duplicate step id: ${step.id}`);
      stepIds.add(step.id);
      if (step.type === "extract-text" || step.type === "extract-list") {
        if (outputKeys.has(step.output)) {
          throw new CompileError(`Duplicate output key: ${step.output}`);
        }
        outputKeys.add(step.output);
      }
      validateStep(step);
    }
  }

  return structuredClone(automation);
}

function validateStep(step: Step): void {
  switch (step.type) {
    case "click":
      validateLocator(step.locator, step.id);
      return;
    case "fill":
    case "select":
      validateLocator(step.locator, step.id);
      if (!stepValuePresent(step.value)) {
        throw new CompileError(`Step ${step.id} requires a value`);
      }
      return;
    case "extract-text":
      validateLocator(step.locator, step.id);
      if (step.output.length === 0) {
        throw new CompileError(`Step ${step.id} requires an output key`);
      }
      return;
    case "extract-list":
      validateLocator(step.locator, step.id);
      if (step.output.length === 0) {
        throw new CompileError(`Step ${step.id} requires an output key`);
      }
      if (Object.keys(step.fields).length === 0) {
        throw new CompileError(`Step ${step.id} requires extract-list fields`);
      }
      for (const [key, field] of Object.entries(step.fields)) {
        if (key.length === 0) throw new CompileError(`Step ${step.id} has an empty field name`);
        if (field.source === "text" && field.locator !== undefined)
          validateLocator(field.locator, `${step.id}.${key}`);
        if (field.source === "attr" || field.source === "url") {
          if (field.name.length === 0) {
            throw new CompileError(`Step ${step.id} field ${key} needs an attribute name`);
          }
          if (field.locator !== undefined) validateLocator(field.locator, `${step.id}.${key}`);
        }
      }
      return;
    case "navigate":
      if (!stepValuePresent(step.url)) throw new CompileError(`Step ${step.id} requires a url`);
      return;
    default:
      throw new CompileError(`Unknown step type: ${(step as Step).type}`);
  }
}

export function validateLocator(locator: LocatorDefinition, stepId: string): void {
  const allowed = {
    role: "name",
    text: "text",
    label: "label",
    "test-id": "testId",
    css: undefined,
  };
  for (const [key, value] of Object.entries(locator.bindings ?? {})) {
    if (
      key !== allowed[locator.strategy] ||
      !value ||
      (value.kind !== "input" && value.kind !== "literal") ||
      !stepValuePresent(value)
    )
      throw new CompileError(`Step ${stepId} has invalid locator binding ${key}`);
  }
  if (
    locator.attribute &&
    (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(locator.attribute.name) ||
      !stepValuePresent(locator.attribute.value))
  )
    throw new CompileError(`Step ${stepId} has invalid attribute binding`);
  if (locator.within !== undefined) {
    validateScope(locator.within, stepId);
  }
  switch (locator.strategy) {
    case "role":
      if (locator.role.length === 0)
        throw new CompileError(`Step ${stepId} role locator needs a role`);
      return;
    case "text":
      if (locator.text.length === 0)
        throw new CompileError(`Step ${stepId} text locator needs text`);
      return;
    case "label":
      if (locator.label.length === 0)
        throw new CompileError(`Step ${stepId} label locator needs a label`);
      return;
    case "test-id":
      if (locator.testId.length === 0)
        throw new CompileError(`Step ${stepId} test-id locator needs a test id`);
      return;
    case "css":
      if (locator.selector.length === 0)
        throw new CompileError(`Step ${stepId} css locator needs a selector`);
      return;
    default:
      throw new CompileError(`Step ${stepId} has an unknown locator strategy`);
  }
}

function validateScope(scope: LocatorDefinition["within"], stepId: string): void {
  if (scope === undefined) return;
  if (scope.kind === "container") {
    validateLocator(scope.locator, stepId);
    return;
  }
  if (scope.kind === "form") {
    if (scope.name.length === 0) {
      throw new CompileError(`Step ${stepId} form scope needs a name`);
    }
    return;
  }
  if (scope.kind === "landmark") {
    if (scope.role.length === 0) {
      throw new CompileError(`Step ${stepId} landmark scope needs a role`);
    }
    return;
  }
  throw new CompileError(`Step ${stepId} has an unknown locator scope`);
}

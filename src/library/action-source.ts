import { createContext, Script } from "node:vm";
import { defineAction } from "../capabilities/define.js";
import { array, boolean, number, object, optional, string } from "../capabilities/schema.js";
import type { ActionSchema, ActionType, SiteActionDefinition } from "../capabilities/types.js";
import {
  click,
  css,
  extractList,
  extractText,
  fill,
  form,
  hrefField,
  inputRef,
  label,
  landmark,
  literalValue,
  navigate,
  role,
  select,
  testId,
  text,
  textField,
  urlField,
} from "./actions-api.js";
import type {
  FillValue,
  ListField,
  LocatorDefinition,
  LocatorScope,
  Step,
  StepValue,
} from "../core/types.js";
import { stripAutomationTypes } from "../automations/typescript.js";

type EmitSymbol =
  | "array"
  | "boolean"
  | "click"
  | "css"
  | "extractList"
  | "extractText"
  | "fill"
  | "form"
  | "hrefField"
  | "inputRef"
  | "label"
  | "landmark"
  | "literalValue"
  | "navigate"
  | "number"
  | "object"
  | "optional"
  | "role"
  | "select"
  | "string"
  | "testId"
  | "text"
  | "textField"
  | "urlField";

export function emitActionSource(action: SiteActionDefinition): string {
  const used = new Set<EmitSymbol>();
  const body = emitActionBody(action, used);
  const imports = ["defineAction", ...[...used].sort()];
  return `import {\n  ${imports.join(",\n  ")},\n} from "mosaik/actions";\n\n${body}`;
}

function emitActionBody(action: SiteActionDefinition, used: Set<EmitSymbol>): string {
  const aliases =
    action.aliases === undefined || action.aliases.length === 0
      ? ""
      : `\n  aliases: ${JSON.stringify(action.aliases)},`;
  const contexts =
    action.contexts === undefined || action.contexts.length === 0
      ? ""
      : `\n  contexts: ${JSON.stringify(action.contexts)},`;
  return `export const ${action.name} = defineAction({
  id: ${JSON.stringify(action.id)},
  siteId: ${JSON.stringify(action.siteId)},
  name: ${JSON.stringify(action.name)},
  description: ${JSON.stringify(action.description)},${aliases}${contexts}
  safety: ${JSON.stringify(action.safety)},
  inputs: ${emitSchemaMap(action.inputs, 2, used)},
  outputs: ${emitSchemaMap(action.outputs, 2, used)},
  ${["precondition", "completion", "conditionTimeoutMs"]
    .filter((key) => key in action.implementation)
    .map(
      (key) =>
        `${key}: ${JSON.stringify(action.implementation[key as keyof typeof action.implementation])},`,
    )
    .join("\n  ")}
  ${action.implementation.id === undefined ? "" : `implementationId: ${JSON.stringify(action.implementation.id)},`}
  ${action.contractVersion === undefined ? "" : `contractVersion: ${action.contractVersion},`}
  ${action.implementations === undefined ? "" : `implementations: ${JSON.stringify(action.implementations)},`}
  steps: [
${action.implementation.steps.map((step) => `    ${emitStep(step, used)},`).join("\n")}
  ],
});
`;
}

export function parseActionSource(source: string): SiteActionDefinition {
  if (!source.includes("defineAction")) {
    throw new Error("Action source must call defineAction");
  }
  const stripped = stripAutomationTypes(source)
    .replace(/^\s*import\s[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/\bexport\s+default\s+/g, "")
    .replace(/\bexport\s+const\s+/g, "const ")
    .replace(/\bexport\s+\{[^}]*\};?\s*/g, "");

  let captured: SiteActionDefinition | undefined;
  const sandboxDefineAction = (input: Parameters<typeof defineAction>[0]): SiteActionDefinition => {
    captured = defineAction(input);
    return captured;
  };

  const context = createContext({
    defineAction: sandboxDefineAction,
    array,
    boolean,
    click,
    css,
    extractList,
    extractText,
    fill,
    form,
    hrefField,
    inputRef,
    label,
    landmark,
    literalValue,
    navigate,
    number,
    object,
    optional,
    role,
    select,
    string,
    testId,
    text,
    textField,
    urlField,
  });
  try {
    new Script(stripped, { filename: "action.ts" }).runInContext(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Action source is invalid: ${message}`);
  }
  if (captured === undefined) {
    throw new Error("Action source must assign defineAction(...)");
  }
  return captured;
}

function emitSchemaMap(schema: ActionSchema, indent: number, used: Set<EmitSymbol>): string {
  const entries = Object.entries(schema);
  if (entries.length === 0) return "{}";
  const pad = " ".repeat(indent);
  const inner = entries
    .map(([key, value]) => `${pad}  ${JSON.stringify(key)}: ${emitType(value, used)},`)
    .join("\n");
  return `{\n${inner}\n${pad}}`;
}

function emitType(schema: ActionType, used: Set<EmitSymbol>): string {
  const body = (() => {
    switch (schema.type) {
      case "string":
        used.add("string");
        return "string()";
      case "number":
        used.add("number");
        return schema.format === undefined
          ? "number()"
          : `number(${JSON.stringify(schema.format)})`;
      case "boolean":
        used.add("boolean");
        return "boolean()";
      case "array":
        used.add("array");
        return `array(${emitType(schema.items, used)})`;
      case "object":
        used.add("object");
        return `object(${emitSchemaMap(schema.properties, 0, used)})`;
    }
  })();
  if (schema.optional === true) {
    used.add("optional");
    return `optional(${body})`;
  }
  return body;
}

function emitStep(step: Step, used: Set<EmitSymbol>): string {
  if (
    step.ready ||
    step.completion ||
    (step.type === "extract-list" && step.empty) ||
    step.conditionTimeoutMs !== undefined
  )
    return JSON.stringify(step);
  switch (step.type) {
    case "click":
      used.add("click");
      return `click({ id: ${JSON.stringify(step.id)}, locator: ${emitLocator(step.locator, used)}, safety: ${JSON.stringify(step.safety)} })`;
    case "fill":
      used.add("fill");
      return `fill({ id: ${JSON.stringify(step.id)}, locator: ${emitLocator(step.locator, used)}, value: ${emitFillValue(step.value, used)}, safety: ${JSON.stringify(step.safety)} })`;
    case "select":
      used.add("select");
      return `select({ id: ${JSON.stringify(step.id)}, locator: ${emitLocator(step.locator, used)}, value: ${emitFillValue(step.value, used)}, safety: ${JSON.stringify(step.safety)} })`;
    case "navigate":
      used.add("navigate");
      return `navigate({ id: ${JSON.stringify(step.id)}, url: ${emitFillValue(step.url, used)}, safety: ${JSON.stringify(step.safety)} })`;
    case "extract-text":
      used.add("extractText");
      return `extractText({ id: ${JSON.stringify(step.id)}, locator: ${emitLocator(step.locator, used)}, output: ${JSON.stringify(step.output)}, safety: ${JSON.stringify(step.safety)} })`;
    case "extract-list":
      used.add("extractList");
      return `extractList({ id: ${JSON.stringify(step.id)}, locator: ${emitLocator(step.locator, used)}, output: ${JSON.stringify(step.output)}, fields: ${emitFields(step.fields, used)}, safety: ${JSON.stringify(step.safety)} })`;
  }
}

function emitFillValue(value: FillValue, used: Set<EmitSymbol>): string {
  if (typeof value === "string") return JSON.stringify(value);
  return emitStepValue(value, used);
}

function emitStepValue(value: StepValue, used: Set<EmitSymbol>): string {
  if (value.kind === "input") {
    if (value.prefix !== undefined || value.suffix !== undefined) return JSON.stringify(value);
    used.add("inputRef");
    return `inputRef(${JSON.stringify(value.key)})`;
  }
  used.add("literalValue");
  return `literalValue(${JSON.stringify(value.value)})`;
}

function emitLocator(locator: LocatorDefinition, used: Set<EmitSymbol>): string {
  if (locator.bindings || locator.attribute || locator.within?.kind === "container")
    return JSON.stringify(locator);
  const exact =
    "exact" in locator && locator.exact !== undefined ? `, exact: ${locator.exact}` : "";
  const within = locator.within === undefined ? "" : `, within: ${emitScope(locator.within, used)}`;
  switch (locator.strategy) {
    case "role": {
      used.add("role");
      const name = locator.name === undefined ? "" : `, name: ${JSON.stringify(locator.name)}`;
      return `role(${JSON.stringify(locator.role)}, {${name}${exact}${within} })`.replace(
        "{,",
        "{",
      );
    }
    case "text":
      used.add("text");
      return `text(${JSON.stringify(locator.text)}, {${exact}${within} })`.replace("{,", "{");
    case "label":
      used.add("label");
      return `label(${JSON.stringify(locator.label)}, {${exact}${within} })`.replace("{,", "{");
    case "test-id":
      used.add("testId");
      return `testId(${JSON.stringify(locator.testId)}, {${within} })`.replace("{,", "{");
    case "css":
      used.add("css");
      return `css(${JSON.stringify(locator.selector)}, {${within} })`.replace("{,", "{");
  }
}

function emitScope(scope: LocatorScope, used: Set<EmitSymbol>): string {
  if (scope.kind === "container") return JSON.stringify(scope);
  if (scope.kind === "form") {
    used.add("form");
    return `form(${JSON.stringify(scope.name)})`;
  }
  used.add("landmark");
  const name = scope.name === undefined ? "" : `, name: ${JSON.stringify(scope.name)}`;
  return `landmark(${JSON.stringify(scope.role)}${name === "" ? "" : `, {${name} }`})`.replace(
    "{,",
    "{",
  );
}

function emitFields(fields: Record<string, ListField>, used: Set<EmitSymbol>): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return "{}";
  return `{ ${entries.map(([key, field]) => `${JSON.stringify(key)}: ${emitField(field, used)}`).join(", ")} }`;
}

function emitField(field: ListField, used: Set<EmitSymbol>): string {
  if (field.optional !== undefined) return JSON.stringify(field);
  if (field.source === "text") {
    used.add("textField");
    return field.locator === undefined
      ? "textField()"
      : `textField(${emitLocator(field.locator, used)})`;
  }
  if (field.source === "url") {
    used.add("urlField");
    return field.locator === undefined
      ? `urlField(${JSON.stringify(field.name)})`
      : `urlField(${JSON.stringify(field.name)}, ${emitLocator(field.locator, used)})`;
  }
  if (field.locator === undefined) {
    if (field.name === "href") {
      used.add("hrefField");
      return "hrefField()";
    }
    return `{ source: "attr", name: ${JSON.stringify(field.name)} }`;
  }
  if (field.name === "href") {
    used.add("hrefField");
    return `hrefField(${emitLocator(field.locator, used)})`;
  }
  return `{ source: "attr", name: ${JSON.stringify(field.name)}, locator: ${emitLocator(field.locator, used)} }`;
}

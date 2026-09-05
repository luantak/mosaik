import type { Locator, Page } from "playwright";
import type { LocatorDefinition, LocatorScope } from "../core/index.js";
import { resolveStepValue, scopeLabel } from "../core/index.js";

type LocatorRoot = Pick<Page, "getByRole" | "getByText" | "getByLabel" | "getByTestId" | "locator">;

export function resolveLocator(
  root: LocatorRoot,
  locator: LocatorDefinition,
  inputs: Record<string, unknown> = {},
): Locator {
  locator = bindLocator(locator, inputs);
  const target = resolveLiteralLocator(root, locator);
  return locator.attribute === undefined
    ? target
    : target.and(
        root.locator(
          `[${locator.attribute.name}=${cssString(resolveStepValue(locator.attribute.value, inputs))}]`,
        ),
      );
}

function resolveLiteralLocator(root: LocatorRoot, locator: LocatorDefinition): Locator {
  const scoped = resolveScope(root, locator.within);
  switch (locator.strategy) {
    case "role":
      return scoped.getByRole(
        locator.role as Parameters<Page["getByRole"]>[0],
        locator.name === undefined
          ? undefined
          : { name: locator.name, exact: locator.exact !== false },
      );
    case "text":
      return scoped.getByText(locator.text, { exact: locator.exact !== false });
    case "label":
      return scoped.getByLabel(locator.label, { exact: locator.exact !== false });
    case "test-id":
      return scoped.getByTestId(locator.testId);
    case "css":
      return scoped.locator(locator.selector);
  }
}

export function locatorLabel(locator: LocatorDefinition): string {
  const scope = locator.within === undefined ? "" : `${scopeLabel(locator.within)} >> `;
  switch (locator.strategy) {
    case "role":
      return `${scope}role=${locator.role}${locator.name === undefined ? "" : ` name=${locator.name}`}`;
    case "text":
      return `${scope}text=${locator.text}`;
    case "label":
      return `${scope}label=${locator.label}`;
    case "test-id":
      return `${scope}test-id=${locator.testId}`;
    case "css":
      return `${scope}css=${locator.selector}`;
  }
}

function resolveScope(root: LocatorRoot, scope: LocatorScope | undefined): LocatorRoot {
  if (scope === undefined) return root;
  if (scope.kind === "container") return resolveLocator(root, scope.locator);
  if (scope.kind === "form") {
    return root.getByRole("form", { name: scope.name, exact: true });
  }
  return root.getByRole(
    scope.role as Parameters<Page["getByRole"]>[0],
    scope.name === undefined ? undefined : { name: scope.name, exact: true },
  );
}

export function bindLocator(
  locator: LocatorDefinition,
  inputs: Record<string, unknown> = {},
): LocatorDefinition {
  const result = structuredClone(locator);
  for (const [key, value] of Object.entries(result.bindings ?? {})) {
    if (!["name", "text", "label", "testId"].includes(key))
      throw new Error(
        `Unsupported locator binding: ${key}. Binding keys are semantic fields (name, text, label, testId), not input names. For a variable inside a label use bindings:{name:{kind:"input",key:${JSON.stringify(key)},prefix:"Go to item ",suffix:""}}. Set example inputs before testing; do not use {input} placeholders in the label.`,
      );
    (result as unknown as Record<string, unknown>)[key] = resolveStepValue(value, inputs);
  }
  delete result.bindings;
  if (result.attribute) {
    const value = result.attribute.value;
    if (
      typeof result.attribute.name !== "string" ||
      !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(result.attribute.name) ||
      (typeof value !== "string" &&
        (!value ||
          typeof value !== "object" ||
          (value.kind !== "literal" && value.kind !== "input") ||
          (value.kind === "literal"
            ? typeof value.value !== "string"
            : typeof value.key !== "string" || !value.key)))
    )
      throw new Error(
        'Locator attribute requires {name, value}, for example {name:"href", value:"/destination"} or {name:"href", value:{kind:"input", key:"item.href"}}',
      );
    result.attribute.value = resolveStepValue(result.attribute.value, inputs);
  }
  if (result.within?.kind === "container")
    result.within.locator = bindLocator(result.within.locator, inputs);
  return result;
}

function cssString(value: string): string {
  return (
    '"' +
    Array.from(value, (c) =>
      c === "\0" ? "\\fffd " : /["\\\n\r\f]/.test(c) ? `\\${c.codePointAt(0)!.toString(16)} ` : c,
    ).join("") +
    '"'
  );
}

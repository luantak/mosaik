import { compile } from "./compile.js";
import type {
  Automation,
  ClickStep,
  ExtractListStep,
  ExtractTextStep,
  FillStep,
  ListField,
  LocatorDefinition,
  LocatorScope,
  NavigateStep,
  SelectStep,
  Step,
  StepValue,
} from "./types.js";

/**
 * Safety is an author-stated semantic, not inferred from the browser primitive.
 *
 * A click can be read-only (expand a details row), browser-local (advance a
 * wizard), or an external side effect (place an order, send a message). Write
 * `safety: "external-side-effect"` on `click({ name: "Place order" })`. The
 * repair agent does not guess this.
 */
export function automation(id: string, define: () => Step[]): Automation {
  return compile({
    id,
    version: 1,
    actions: [
      {
        id: `${id}/main`,
        name: id,
        steps: define(),
      },
    ],
  });
}

export function click(input: Omit<ClickStep, "type">): ClickStep {
  return { ...input, type: "click" };
}
export function fill(input: Omit<FillStep, "type">): FillStep {
  return { ...input, type: "fill" };
}
export function select(input: Omit<SelectStep, "type">): SelectStep {
  return { ...input, type: "select" };
}
export function navigate(input: Omit<NavigateStep, "type">): NavigateStep {
  return { ...input, type: "navigate" };
}
export function extractText(input: Omit<ExtractTextStep, "type">): ExtractTextStep {
  return { ...input, type: "extract-text" };
}
export function extractList(input: Omit<ExtractListStep, "type">): ExtractListStep {
  return { ...input, type: "extract-list" };
}

export function textField(locator?: LocatorDefinition): ListField {
  return locator === undefined ? { source: "text" } : { source: "text", locator };
}

export function hrefField(locator?: LocatorDefinition): ListField {
  return locator === undefined
    ? { source: "attr", name: "href" }
    : { source: "attr", name: "href", locator };
}

export function urlField(name: string, locator?: LocatorDefinition): ListField {
  return locator === undefined ? { source: "url", name } : { source: "url", name, locator };
}

export function inputRef(key: string): StepValue {
  return { kind: "input", key };
}

export function literalValue(value: string): StepValue {
  return { kind: "literal", value };
}

export function role(
  roleName: string,
  options?: { name?: string; exact?: boolean; within?: LocatorScope },
): LocatorDefinition {
  return {
    strategy: "role",
    role: roleName,
    ...(options?.name === undefined ? {} : { name: options.name }),
    ...locatorOptions(options),
  };
}

export function text(
  value: string,
  options?: { exact?: boolean; within?: LocatorScope },
): LocatorDefinition {
  return { strategy: "text", text: value, ...locatorOptions(options) };
}

export function label(
  value: string,
  options?: { exact?: boolean; within?: LocatorScope },
): LocatorDefinition {
  return { strategy: "label", label: value, ...locatorOptions(options) };
}

export function testId(value: string, options?: { within?: LocatorScope }): LocatorDefinition {
  return { strategy: "test-id", testId: value, ...locatorOptions(options) };
}

export function css(selector: string, options?: { within?: LocatorScope }): LocatorDefinition {
  return { strategy: "css", selector, ...locatorOptions(options) };
}

export function form(name: string): LocatorScope {
  return { kind: "form", name };
}

export function landmark(role: string, options?: { name?: string }): LocatorScope {
  return options?.name === undefined
    ? { kind: "landmark", role }
    : { kind: "landmark", role, name: options.name };
}

function locatorOptions(options?: { exact?: boolean; within?: LocatorScope }): {
  exact?: boolean;
  within?: LocatorScope;
} {
  return {
    ...(options?.exact === undefined ? {} : { exact: options.exact }),
    ...(options?.within === undefined ? {} : { within: options.within }),
  };
}

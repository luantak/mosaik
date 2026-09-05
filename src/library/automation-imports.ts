import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { AutomationValidationError } from "../automations/types.js";
import { automationSourcePath } from "./paths.js";

export type AutomationImport =
  | { kind: "mosaik-automations" }
  | { kind: "mosaik-actions" }
  | {
      kind: "action";
      actionName: string;
      names: string[];
      specifier: string;
    }
  | {
      kind: "automation";
      automationId: string;
      localName: string;
      specifier: string;
    };

const IMPORT_LINE =
  /^\s*import\s+(?:(\w+)|(?:\{([^}]*)\})|(?:\*\s+as\s+(\w+)))\s+from\s+["']([^"']+)["']\s*;?\s*$/gm;

export function parseAutomationImports(source: string): AutomationImport[] {
  const imports: AutomationImport[] = [];
  for (const match of source.matchAll(IMPORT_LINE)) {
    const defaultName = match[1];
    const named = match[2];
    const namespace = match[3];
    const specifier = match[4];
    if (specifier === undefined) continue;
    if (namespace !== undefined) {
      throw new AutomationValidationError("Namespace imports are not allowed");
    }
    if (specifier === "mosaik/automations") {
      imports.push({ kind: "mosaik-automations" });
      continue;
    }
    if (specifier === "mosaik/actions") {
      imports.push({ kind: "mosaik-actions" });
      continue;
    }
    if (!specifier.startsWith(".")) {
      throw new AutomationValidationError(`Import is not allowed: ${specifier}`);
    }
    const action = parseActionSpecifier(specifier);
    if (action !== undefined) {
      const names = namedNames(named);
      if (defaultName !== undefined) {
        throw new AutomationValidationError("Action imports must be named imports");
      }
      if (names.length === 0) {
        throw new AutomationValidationError(`Action import from ${specifier} must name bindings`);
      }
      imports.push({
        kind: "action",
        actionName: action.actionName,
        names,
        specifier,
      });
      continue;
    }
    const automation = parseAutomationSpecifier(specifier);
    if (automation !== undefined) {
      const bindings = namedNames(named);
      if (defaultName === undefined && bindings.length !== 1) {
        throw new AutomationValidationError("Automation imports must name exactly one automation");
      }
      imports.push({
        kind: "automation",
        automationId: automation,
        localName: defaultName ?? bindings[0]!,
        specifier,
      });
      continue;
    }
    throw new AutomationValidationError(`Import is not allowed: ${specifier}`);
  }
  return imports;
}

export function stripAutomationImports(source: string): string {
  return source.replace(IMPORT_LINE, "").replace(/^\s*\n+/, "");
}

export function referencedImportedActions(source: string): string[] {
  const names = new Set<string>();
  for (const entry of parseAutomationImports(source)) {
    if (entry.kind === "action") {
      for (const name of entry.names) names.add(name);
    }
  }
  return [...names];
}

export function referencedImportedAutomations(source: string): string[] {
  return parseAutomationImports(source)
    .filter(
      (entry): entry is Extract<AutomationImport, { kind: "automation" }> =>
        entry.kind === "automation",
    )
    .map((entry) => entry.automationId);
}

export function assertImportsStayInLibrary(input: {
  libraryRoot: string;
  siteId: string;
  fromAutomationId: string;
  imports: AutomationImport[];
}): void {
  const fromPath = automationSourcePath(input.libraryRoot, input.siteId, input.fromAutomationId);
  const fromDir = dirname(fromPath);
  for (const entry of input.imports) {
    if (entry.kind !== "action" && entry.kind !== "automation") continue;
    const resolved = resolve(fromDir, entry.specifier);
    if (!pathInside(input.libraryRoot, resolved)) {
      throw new AutomationValidationError(`Import escapes the library root: ${entry.specifier}`);
    }
  }
}

function parseActionSpecifier(specifier: string): { actionName: string } | undefined {
  const sibling = specifier.match(/^\.\.\/actions\/([A-Za-z_][A-Za-z0-9_]*)\.(?:js|ts)$/);
  if (sibling?.[1] !== undefined) return { actionName: sibling[1] };
  return undefined;
}

function parseAutomationSpecifier(specifier: string): string | undefined {
  const cleaned = specifier.replace(/^\.\//, "").replace(/\.js$/, "").replace(/\.ts$/, "");
  if (cleaned.includes("/") || cleaned.includes("\\") || cleaned.includes("..")) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cleaned)) {
    throw new AutomationValidationError(`Invalid automation import: ${specifier}`);
  }
  return cleaned;
}

function namedNames(named: string | undefined): string[] {
  if (named === undefined) return [];
  return named
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const alias = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
      if (alias?.[2] !== undefined) return alias[2];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
        throw new AutomationValidationError(`Invalid import binding: ${part}`);
      }
      return part;
    });
}

function pathInside(root: string, target: string): boolean {
  if (isAbsolute(target) === false) return false;
  const relativePath = relative(normalize(root), normalize(target));
  return relativePath !== "" && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

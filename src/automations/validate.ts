import { normalizeAutomationModule } from "../library/automation-module.js";
import { Script } from "node:vm";
import {
  assertImportsStayInLibrary,
  parseAutomationImports,
  referencedImportedActions,
  stripAutomationImports,
} from "../library/automation-imports.js";
import { AutomationValidationError } from "./types.js";
import { stripAutomationTypes } from "./typescript.js";

const FORBIDDEN_IDENTIFIERS = [
  "process",
  "require",
  "playwright",
  "fetch",
  "Buffer",
  "globalThis",
  "global",
  "eval",
  "Function",
  "Deno",
  "Bun",
  "WebAssembly",
  "XMLHttpRequest",
  "Worker",
  "SharedArrayBuffer",
  "Atomics",
  "fs",
  "child_process",
  "parentPort",
  "workerData",
  "WebSocket",
];

export function validateAutomation(
  source: string,
  options: {
    actionNames?: string[];
    libraryRoot?: string;
    siteId?: string;
    automationId?: string;
  } = {},
): void {
  if (source.trim().length === 0) {
    throw new AutomationValidationError("Automation source is empty");
  }
  // Parse before removing imports: malformed line separators can otherwise
  // swallow the entire module and produce a misleading missing-export error.
  try {
    stripAutomationTypes(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AutomationValidationError(
      `Invalid TypeScript source: ${detail}. Pass automationSource as source text with actual line breaks, not literal backslash-n separators.`,
    );
  }
  source = normalizeAutomationModule(source);
  if (!source.includes("defineAutomation")) {
    throw new AutomationValidationError("Automation must call defineAutomation");
  }
  if (!/\bexport\s+default\s+defineAutomation\b/.test(source)) {
    throw new AutomationValidationError(
      "Automation must export default defineAutomation(async (ctx, input) => ...)",
    );
  }
  if (/\bimport\s*\(/.test(source)) {
    throw new AutomationValidationError("Dynamic import() is not allowed");
  }
  const imports = parseAutomationImports(source);
  if (
    options.libraryRoot !== undefined &&
    options.siteId !== undefined &&
    options.automationId !== undefined
  ) {
    assertImportsStayInLibrary({
      libraryRoot: options.libraryRoot,
      siteId: options.siteId,
      fromAutomationId: options.automationId,
      imports,
    });
  }
  if (/\brequire\s*\(/.test(source)) {
    throw new AutomationValidationError("require is not allowed");
  }
  if (/\bnew\s+Function\b/.test(source)) {
    throw new AutomationValidationError("new Function is not allowed");
  }
  if (/\bpage\.(locator|click|fill|goto|evaluate)\b/.test(source)) {
    throw new AutomationValidationError("Raw browser access is not allowed");
  }
  const withoutImports = stripAutomationImports(source);
  const stripped = stripAutomationTypes(withoutImports);
  if (!/\bexport\s+default\s+defineAutomation\s*\(/.test(stripped)) {
    throw new AutomationValidationError(
      "Automation must export default defineAutomation(async (ctx, input) => ...)",
    );
  }
  for (const name of FORBIDDEN_IDENTIFIERS) {
    if (new RegExp(`\\b${name}\\b`).test(withoutImports)) {
      throw new AutomationValidationError(`Forbidden identifier: ${name}`);
    }
  }
  if (/\bctx\.actions\s*\[/.test(source)) {
    throw new AutomationValidationError("Dynamic action names are not allowed");
  }
  try {
    new Script(stripped.replace(/export\s+default\s+/, "exports.default = "));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AutomationValidationError(`Automation syntax is invalid: ${message}`);
  }

  const available = options.actionNames;
  if (available === undefined) return;
  const allowed = new Set(available);
  for (const name of referencedActions(source)) {
    if (!allowed.has(name)) {
      throw new AutomationValidationError(`Unknown action: ${name}`);
    }
  }
}

export function referencedActions(source: string): string[] {
  const names = new Set<string>(referencedImportedActions(source));
  const pattern = /\bctx\.actions\.([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

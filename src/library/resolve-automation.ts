import { normalizeAutomationModule } from "./automation-module.js";
import { validateAutomation } from "../automations/validate.js";
import { readFile } from "node:fs/promises";
import { AutomationValidationError, type ComposedAutomation } from "../automations/types.js";
import { stripAutomationTypes } from "../automations/typescript.js";
import {
  assertImportsStayInLibrary,
  parseAutomationImports,
  stripAutomationImports,
} from "./automation-imports.js";
import { automationSourcePath } from "./paths.js";

export interface ResolvedAutomationSource {
  source: string;
  actionNames: string[];
  automationIds: string[];
}

export async function resolveAutomationSourceForExecution(input: {
  libraryRoot?: string;
  automation: ComposedAutomation;
  loadAutomationSource?: (automationId: string) => Promise<string | undefined>;
}): Promise<ResolvedAutomationSource> {
  const stack = new Set<string>();
  const actionNames = new Set<string>();
  const automationIds = new Set<string>([input.automation.id]);

  const load =
    input.loadAutomationSource ??
    (input.libraryRoot === undefined
      ? async () => undefined
      : async (automationId: string) => {
          try {
            return await readFile(
              automationSourcePath(input.libraryRoot!, input.automation.siteId, automationId),
              "utf8",
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          }
        });

  async function rewrite(automationId: string, source: string, nested: boolean): Promise<string> {
    if (stack.has(automationId)) {
      throw new AutomationValidationError(`Automation import cycle involving ${automationId}`);
    }
    stack.add(automationId);
    try {
      source = normalizeAutomationModule(source);
      validateAutomation(source);
      const imports = parseAutomationImports(source);
      if (input.libraryRoot !== undefined) {
        assertImportsStayInLibrary({
          libraryRoot: input.libraryRoot,
          siteId: input.automation.siteId,
          fromAutomationId: automationId,
          imports,
        });
      }

      const actionBindings: string[] = [];
      const automationBindings: string[] = [];

      for (const entry of imports) {
        if (entry.kind === "action") {
          for (const name of entry.names) {
            actionNames.add(name);
            actionBindings.push(
              `const ${name} = (first = {}, second) => actions[${JSON.stringify(name)}](second === undefined ? (first === ctx ? {} : first) : second);`,
            );
          }
          continue;
        }
        if (entry.kind === "automation") {
          if (nested) {
            throw new AutomationValidationError(
              "Nested automation imports are limited to one level",
            );
          }
          automationIds.add(entry.automationId);
          const nestedSource = await load(entry.automationId);
          if (nestedSource === undefined) {
            throw new AutomationValidationError(`Unknown automation import: ${entry.automationId}`);
          }
          const nestedHandler = await rewrite(entry.automationId, nestedSource, true);
          const handlerName = `__automation_${sanitizeIdent(entry.automationId)}`;
          automationBindings.push(`const ${handlerName} = ${nestedHandler};`);
          automationBindings.push(
            `const ${entry.localName} = async (first = {}, second) => ${handlerName}(ctx, second === undefined ? (first === ctx ? {} : first) : second);`,
          );
        }
      }

      const body = stripAutomationImports(source).trim();
      if (nested) return injectBindingsIntoHandler(body, actionBindings);
      const prelude = [...actionBindings, ...automationBindings];
      if (prelude.length === 0) return body;
      return `${prelude.join("\n")}\n${body}`;
    } finally {
      stack.delete(automationId);
    }
  }

  return {
    source: await rewrite(input.automation.id, input.automation.source, false),
    actionNames: [...actionNames],
    automationIds: [...automationIds],
  };
}

function injectBindingsIntoHandler(moduleSource: string, bindings: string[]): string {
  const stripped = stripAutomationTypes(moduleSource).trim();
  const match = stripped.match(
    /^export\s+default\s+defineAutomation\s*\(\s*(async\s*)?\(([^)]*)\)\s*=>\s*\{([\s\S]*)\}\s*\)\s*;?\s*$/,
  );
  if (match === null) {
    throw new AutomationValidationError(
      "Imported automation must export default defineAutomation(async (ctx, input) => { ... })",
    );
  }
  const asyncKeyword = match[1] ?? "";
  const params = match[2] ?? "ctx, input";
  const body = match[3] ?? "";
  if (bindings.length === 0) {
    return `defineAutomation(${asyncKeyword}(${params}) => {${body}})`;
  }
  return `defineAutomation(${asyncKeyword}(${params}) => {\n${bindings.map((line) => `  ${line}`).join("\n")}\n${body}})`;
}

function sanitizeIdent(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

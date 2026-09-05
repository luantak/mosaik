import { parse } from "acorn";
import { stripAutomationTypes } from "../automations/typescript.js";
import { AutomationValidationError } from "../automations/types.js";

/** Reduce the public module wrapper to the sandbox's single default handler. */
export function normalizeAutomationModule(source: string): string {
  const js = stripAutomationTypes(source);
  let ast;
  try {
    ast = parse(js, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw new AutomationValidationError(
      `Automation syntax is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let handlers = 0;
  for (const statement of ast.body) {
    let call;
    if (statement.type === "ExportDefaultDeclaration") call = statement.declaration;
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration?.type === "VariableDeclaration"
    ) {
      const declarations = statement.declaration.declarations;
      if (declarations.length === 1) call = declarations[0]?.init;
    }
    if (
      call?.type !== "CallExpression" ||
      call.callee.type !== "Identifier" ||
      call.callee.name !== "defineAutomation"
    )
      continue;
    handlers++;
    const args = call.arguments;
    const handler = args.length === 2 ? args[1] : args[0];
    if (args.length === 2 && js.slice(args[0]!.start, args[0]!.end) !== "import.meta.url") {
      throw new AutomationValidationError("Automation module location must be import.meta.url");
    }
    if (
      (args.length !== 1 && args.length !== 2) ||
      !handler ||
      (handler.type !== "ArrowFunctionExpression" && handler.type !== "FunctionExpression")
    ) {
      throw new AutomationValidationError("defineAutomation requires a function body");
    }
    edits.push({
      start: statement.start,
      end: statement.end,
      text: `export default defineAutomation(${js.slice(handler.start, handler.end)});`,
    });
  }
  if (handlers !== 1)
    throw new AutomationValidationError(
      "Automation must export exactly one defineAutomation handler",
    );
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = js.slice(0, edit.start) + edit.text + js.slice(edit.end);
  return source;
}

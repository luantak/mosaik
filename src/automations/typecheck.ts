import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ActionSchema, ActionType } from "../capabilities/types.js";
import { parseAutomationImports, stripAutomationImports } from "../library/automation-imports.js";
import { AutomationValidationError } from "./types.js";

const execFileAsync = promisify(execFile);

type ActionContract = { name: string; inputs: ActionSchema; outputs: ActionSchema };

/** Check generated calls against learned contracts before persisting a automation. */
export async function typecheckAutomation(
  source: string,
  actions: ActionContract[],
  suppliedInputs?: Record<string, unknown>,
): Promise<void> {
  const byName = new Map(actions.map((action) => [action.name, action]));
  const declarations: string[] = [];
  for (const entry of parseAutomationImports(source)) {
    if (entry.kind === "action") {
      for (const name of entry.names) {
        const action = byName.get(name);
        if (action) declarations.push(`declare const ${name}: ${actionType(action)};`);
      }
    } else if (entry.kind === "automation") {
      declarations.push(
        `declare const ${entry.localName}: (ctxOrInput?: any, input?: any) => Promise<any>;`,
      );
    }
  }
  if (suppliedInputs !== undefined)
    declarations.push(`const __mosaikSuppliedInputs = ${JSON.stringify(suppliedInputs)};`);
  const inputConstraint =
    suppliedInputs === undefined
      ? ""
      : " & (typeof __mosaikSuppliedInputs extends Input ? unknown : { missingOrInvalidAutomationInputs: Input })";
  declarations.push(`declare function defineAutomation<Input = any, Output = any>(
    handler: ((ctx: { actions: { ${actions.map((a) => `${JSON.stringify(a.name)}: ${actionType(a)}`).join("; ")} }; [key: string]: any }, input: Input) => Output)${inputConstraint}
  ): unknown;`);
  declarations.push(
    declarations[declarations.length - 1]!.replace("handler:", "moduleUrl: string, handler:"),
  );
  const prelude = declarations.join("\n") + "\n";
  const root = await mkdtemp(join(tmpdir(), "mosaik-typecheck-"));
  try {
    await writeFile(join(root, "automation.ts"), `${prelude}${stripAutomationImports(source)}`);
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "ESNext",
          strict: true,
          noImplicitAny: false,
          noEmit: true,
          types: [],
          skipLibCheck: true,
        },
        files: ["automation.ts"],
      }),
    );
    const compiler = join(
      dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))),
      "bin",
      "tsc",
    );
    try {
      await execFileAsync(
        process.execPath,
        [compiler, "--project", join(root, "tsconfig.json"), "--pretty", "false"],
        {
          cwd: root,
          timeout: 30_000,
          maxBuffer: 1_048_576,
        },
      );
    } catch (error) {
      const output = (error as { stdout?: string }).stdout?.trim();
      if (!output) throw error;
      throw new AutomationValidationError(
        `Automation does not match action contracts or supplied inputs:\n${output.replace(/^.*?automation\.ts(?=\()/gm, "automation.ts")}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function actionType(action: ActionContract): string {
  const optional = Object.values(action.inputs).every((field) => field.optional === true);
  return `{ (args${optional ? "?" : ""}: ${objectType(action.inputs)}): Promise<${objectType(action.outputs)}>; (ctx: any, args: ${objectType(action.inputs)}): Promise<${objectType(action.outputs)}> }`;
}

function objectType(fields: ActionSchema): string {
  return `{ ${Object.entries(fields)
    .map(
      ([key, value]) => `${JSON.stringify(key)}${value.optional ? "?" : ""}: ${fieldType(value)}`,
    )
    .join("; ")} }`;
}

function fieldType(field: ActionType): string {
  if (field.type === "object") return objectType(field.properties);
  if (field.type === "array") return `Array<${fieldType(field.items)}>`;
  return field.type;
}

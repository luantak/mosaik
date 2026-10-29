import { parse, type Node } from "acorn";
import type { ActionSchema, ActionType } from "../capabilities/types.js";
import { validateObject, validateSchemaMap } from "../capabilities/schema.js";
import { stripAutomationTypes } from "../automations/typescript.js";

/** Read the public input contract without evaluating source. The deliberately small
 * type grammar fails closed for types that cannot be validated deterministically. */
export function automationInputSchema(source: string): ActionSchema {
  // Node's strip mode retains offsets, so Acorn identifies the exact public
  // handler while the original source supplies its erased type annotation.
  const stripped = stripAutomationTypes(source);
  const file = parse(stripped, { ecmaVersion: "latest", sourceType: "module" });
  const aliases = new Map<string, number>();
  for (const match of source.matchAll(/\btype\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    if (stripped.slice(match.index, match.index + match[0].length).trim() === "")
      aliases.set(match[1]!, match.index + match[0].length);
  }
  let input: Node | undefined;
  let genericOffset: number | undefined;
  let handlers = 0;
  for (const statement of file.body) {
    let call;
    if (statement.type === "ExportDefaultDeclaration") call = statement.declaration;
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration?.type === "VariableDeclaration"
    )
      call = statement.declaration.declarations[0]?.init;
    if (
      call?.type !== "CallExpression" ||
      call.callee.type !== "Identifier" ||
      call.callee.name !== "defineAutomation"
    )
      continue;
    const handler = call.arguments[call.arguments.length - 1];
    if (
      !handler ||
      (handler.type !== "ArrowFunctionExpression" && handler.type !== "FunctionExpression")
    )
      continue;
    handlers++;
    const parameter = handler.params[1];
    input = parameter?.type === "AssignmentPattern" ? parameter.left : parameter;
    genericOffset = call.callee.end;
  }
  if (handlers !== 1)
    throw new Error("Automation must export exactly one defineAutomation handler");
  if (!input) return {};
  const reader = new InputTypeReader(source, input.end, aliases);
  let resolved: ActionType;
  if (reader.consume(":")) {
    resolved = reader.type();
    if (![undefined, ")", ",", "="].includes(reader.peek()))
      throw new Error(`Unsupported automation input type near ${reader.peek()}`);
  } else {
    const generic = new InputTypeReader(source, genericOffset!, aliases);
    if (!generic.consume("<"))
      throw new Error("Saved execution requires an explicit automation input type");
    resolved = generic.type();
    if (![">", ","].includes(generic.peek() ?? ""))
      throw new Error("Unsupported automation input generic type");
  }
  if (resolved.type !== "object") throw new Error("Automation inputs must be an object type");
  return resolved.properties;
}

class InputTypeReader {
  constructor(
    readonly source: string,
    private offset: number,
    readonly aliases: Map<string, number>,
    readonly resolving = new Set<string>(),
  ) {}

  private token(): { text: string; end: number } | undefined {
    const rest = this.source.slice(this.offset);
    const skipped =
      rest.match(/^(?:(?:\s+)|(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\n]*(?:\n|$)))*/)?.[0].length ?? 0;
    const text = rest
      .slice(skipped)
      .match(/^(?:[A-Za-z_$][\w$]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|.)/)?.[0];
    return text === undefined ? undefined : { text, end: this.offset + skipped + text.length };
  }

  peek(): string | undefined {
    return this.token()?.text;
  }
  consume(expected: string): boolean {
    const token = this.token();
    if (token?.text !== expected) return false;
    this.offset = token.end;
    return true;
  }
  private take(): string {
    const token = this.token();
    if (!token) throw new Error("Incomplete automation input type");
    this.offset = token.end;
    return token.text;
  }
  private expect(expected: string): void {
    if (!this.consume(expected))
      throw new Error(`Expected '${expected}' in automation input type, received ${this.peek()}`);
  }

  type(): ActionType {
    let value: ActionType;
    const token = this.take();
    if (token === "string" || token === "number" || token === "boolean") value = { type: token };
    else if (token === "(") {
      value = this.type();
      this.expect(")");
    } else if (token === "Array" || token === "ReadonlyArray") {
      this.expect("<");
      value = { type: "array", items: this.type() };
      this.expect(">");
    } else if (token === "{") {
      const properties: ActionSchema = {};
      while (!this.consume("}")) {
        this.consume("readonly");
        const keyToken = this.take();
        const key = keyToken.startsWith('"')
          ? (JSON.parse(keyToken) as string)
          : keyToken.startsWith("'")
            ? keyToken.slice(1, -1)
            : keyToken;
        if (!/^[A-Za-z_$][\w$]*$/.test(key) && !/^['"]/.test(keyToken))
          throw new Error("Automation input types must use named, typed properties");
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw new Error(`Unsafe automation input field: ${key}`);
        const optional = this.consume("?");
        this.expect(":");
        properties[key] = { ...this.type(), ...(optional ? { optional: true } : {}) };
        if (this.peek() !== "}" && !this.consume(";") && !this.consume(","))
          throw new Error(`Unsupported automation input type near ${this.peek()}`);
        while (this.consume(";") || this.consume(",")) {
          /* trailing separators */
        }
      }
      value = { type: "object", properties };
    } else {
      const alias = this.aliases.get(token);
      if (alias === undefined || this.resolving.has(token))
        throw new Error(
          `Unsupported automation input type: ${token}. Use string, number, boolean, arrays, and object properties.`,
        );
      const reader = new InputTypeReader(
        this.source,
        alias,
        this.aliases,
        new Set([...this.resolving, token]),
      );
      value = reader.type();
      if (![undefined, ";", "export", "type", "const", "import"].includes(reader.peek()))
        throw new Error(`Unsupported automation input alias: ${token}`);
    }
    while (this.consume("[")) {
      this.expect("]");
      value = { type: "array", items: value };
    }
    return value;
  }
}

export function validateAutomationInputs(
  schema: ActionSchema,
  input: Record<string, unknown>,
): Record<string, unknown> {
  validateSchemaMap("input", schema);
  rejectUnknown({ type: "object", properties: schema }, input, "input");
  return validateObject(schema, input, "input");
}

function rejectUnknown(schema: ActionType, value: unknown, path: string): void {
  if (schema.type === "array" && Array.isArray(value)) {
    value.forEach((entry, index) => rejectUnknown(schema.items, entry, `${path}[${index}]`));
  } else if (
    schema.type === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    for (const [key, entry] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key))
        throw new Error(`${path}.${key} is not a declared input`);
      rejectUnknown(schema.properties[key]!, entry, `${path}.${key}`);
    }
  }
}

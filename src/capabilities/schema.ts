import type { ActionSchema, ActionType } from "./types.js";

export type StringType = { type: "string" };
export type NumberType = {
  type: "number";
  format?: "decimal-point" | "decimal-comma" | "currency-decimal-point" | "currency-decimal-comma";
};
export type BooleanType = { type: "boolean" };
export type ArrayType<T extends ActionType = ActionType> = { type: "array"; items: T };
export type ObjectType<T extends ActionSchema = ActionSchema> = {
  type: "object";
  properties: T;
};

export function string(): StringType {
  return { type: "string" };
}

export function number(format?: NumberType["format"]): NumberType {
  return { type: "number", ...(format === undefined ? {} : { format }) };
}

export function boolean(): BooleanType {
  return { type: "boolean" };
}

export function array<const T extends ActionType>(items: T): ArrayType<T> {
  return { type: "array", items };
}

export function object<const T extends ActionSchema>(properties: T): ObjectType<T> {
  return { type: "object", properties };
}

export function optional<const T extends ActionType>(
  schema: T,
): Omit<T, "optional"> & { optional: true } {
  return { ...schema, optional: true };
}

export function productRef(): ObjectType<{
  href: StringType;
  title: StringType;
  price: Omit<NumberType, "optional"> & { optional: true };
}> {
  return object({
    href: string(),
    title: string(),
    price: optional(number("currency-decimal-point")),
  });
}

export type InferActionType<T> = T extends { optional: true }
  ? InferActionTypeRequired<Omit<T, "optional">> | undefined
  : InferActionTypeRequired<T>;

type InferActionTypeRequired<T> = T extends { type: "string" }
  ? string
  : T extends { type: "number" }
    ? number
    : T extends { type: "boolean" }
      ? boolean
      : T extends { type: "array"; items: infer Items }
        ? InferActionType<Items>[]
        : T extends { type: "object"; properties: infer Properties extends ActionSchema }
          ? InferActionSchema<Properties>
          : unknown;

export type InferActionSchema<S> = {
  [Key in keyof S]: InferActionType<S[Key]>;
};

export function formatType(schema: ActionType): string {
  switch (schema.type) {
    case "string":
    case "number":
    case "boolean":
      return schema.type;
    case "array":
      return `${formatType(schema.items)}[]`;
    case "object": {
      const fields = Object.entries(schema.properties)
        .map(([key, value]) => `${key}${value.optional === true ? "?" : ""}: ${formatType(value)}`)
        .join("; ");
      return `{ ${fields} }`;
    }
  }
}

export function formatSignature(input: {
  name: string;
  inputs: ActionSchema;
  outputs: ActionSchema;
}): string {
  const params = Object.entries(input.inputs)
    .map(([key, value]) => `${key}${value.optional === true ? "?" : ""}: ${formatType(value)}`)
    .join(", ");
  const outputEntries = Object.entries(input.outputs);
  const result =
    outputEntries.length === 0
      ? "void"
      : `{ ${outputEntries.map(([key, value]) => `${key}: ${formatType(value)}`).join("; ")} }`;
  return `${input.name}(${params.length === 0 ? "" : `args: { ${params} }`}) -> ${result}`;
}

export function validateSchemaMap(label: string, schema: ActionSchema): void {
  for (const [key, value] of Object.entries(schema)) {
    if (key.length === 0) throw new Error(`${label} field name is required`);
    validateType(`${label}.${key}`, value);
  }
}

export function validateValue(schema: ActionType, value: unknown, path: string): unknown {
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") throw new Error(`${path} must be a string`);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${path} must be a number`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
      return value;
    case "array":
      if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
      return value.map((entry, index) => validateValue(schema.items, entry, `${path}[${index}]`));
    case "object":
      return validateObject(schema.properties, value, path);
  }
}

export function validateObject(
  schema: ActionSchema,
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    if (!(key in record) || record[key] === undefined) {
      if (field.optional === true) continue;
      throw new Error(`${path}.${key} is required`);
    }
    result[key] = validateValue(field, record[key], `${path}.${key}`);
  }
  return result;
}

export function coerceValue(schema: ActionType, value: unknown, path: string): unknown {
  if (value === undefined || value === null) {
    if (schema.optional === true) return undefined;
    throw new Error(`${path} is required`);
  }
  switch (schema.type) {
    case "string":
    case "number":
    case "boolean":
      return typeof value === "string"
        ? coerceExtracted(schema, value, path)
        : validateValue(schema, value, path);
    case "array":
      if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
      return value.map((entry, index) => coerceValue(schema.items, entry, `${path}[${index}]`));
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
      }
      const record = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(schema.properties)) {
        if (!(key in record) || record[key] === undefined) {
          if (field.optional === true) continue;
          throw new Error(`${path}.${key} is required`);
        }
        result[key] = coerceValue(field, record[key], `${path}.${key}`);
      }
      return result;
    }
  }
}

export function coerceExtracted(schema: ActionType, raw: string, path: string): unknown {
  switch (schema.type) {
    case "string":
      return raw;
    case "number": {
      let normalized = raw.trim();
      if (schema.format?.startsWith("currency-")) {
        const symbols = normalized.match(/\p{Sc}/gu) ?? [];
        if (symbols.length > 1) throw new Error(`${path} has multiple currency symbols`);
        normalized = normalized.replace(/^\p{Sc}\s*|\s*\p{Sc}$/gu, "");
      }
      const comma = schema.format?.endsWith("decimal-comma") === true;
      const pattern = comma ? /^[+-]?\d+(?:,\d+)?$/ : /^[+-]?\d+(?:\.\d+)?$/;
      if (!pattern.test(normalized))
        throw new Error(
          `${path} has invalid ${schema.format ?? "decimal-point"} number: ${JSON.stringify(raw)}`,
        );
      const parsed = Number(comma ? normalized.replace(",", ".") : normalized);
      if (!Number.isFinite(parsed)) throw new Error(`${path} could not be parsed as a number`);
      return parsed;
    }
    case "boolean": {
      const normalized = raw.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") return true;
      if (normalized === "false" || normalized === "0") return false;
      throw new Error(`${path} could not be parsed as a boolean`);
    }
    case "array":
    case "object":
      throw new Error(`${path} cannot be filled from extract-text`);
  }
}

export function schemasEqual(left: ActionSchema, right: ActionSchema): boolean {
  return stableStringify(left) === stableStringify(right);
}

export function actionInterfacesCompatible(
  left: { inputs: ActionSchema; outputs: ActionSchema },
  right: { inputs: ActionSchema; outputs: ActionSchema },
): boolean {
  return schemasEqual(left.inputs, right.inputs) && schemasEqual(left.outputs, right.outputs);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateType(path: string, schema: ActionType): void {
  switch (schema.type) {
    case "number":
      if (
        schema.format !== undefined &&
        ![
          "decimal-point",
          "decimal-comma",
          "currency-decimal-point",
          "currency-decimal-comma",
        ].includes(schema.format)
      )
        throw new Error(`${path} has an unsupported number format`);
      return;
    case "string":
    case "boolean":
      return;
    case "array":
      validateType(`${path}[]`, schema.items);
      return;
    case "object":
      validateSchemaMap(path, schema.properties);
      return;
    default:
      throw new Error(`${path} has an unknown schema type`);
  }
}

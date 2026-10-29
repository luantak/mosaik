import type { BatchAcceptance } from "../jobs/types.js";

/** An explicit, deterministic contract. Semantic correctness still needs separate review. */
export interface TaskAcceptance extends Omit<BatchAcceptance, "requestedCount"> {
  recordsPath?: string;
  terminationPath: string;
  requestedCount?: number | { input: string };
}

export interface TaskAssessment {
  status: "complete" | "incomplete" | "failed" | "interrupted";
  collected: number;
  failedItems: number;
  terminationReason: string;
  errors: string[];
  outputPaths: string[];
  verification: "deterministic" | "unverified";
}

export function field(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function validateAcceptance(value: BatchAcceptance): void {
  if (
    !value ||
    !Array.isArray(value.requiredFields) ||
    !value.requiredFields.length ||
    value.requiredFields.some((key) => typeof key !== "string" || !key.trim()) ||
    typeof value.idField !== "string" ||
    !value.idField.trim() ||
    typeof value.sourceUrlField !== "string" ||
    !value.sourceUrlField.trim()
  ) {
    throw new Error("Acceptance requires nonempty requiredFields, idField and sourceUrlField");
  }
  if (
    value.requestedCount !== undefined &&
    (!Number.isSafeInteger(value.requestedCount) || value.requestedCount < 1)
  ) {
    throw new Error("Acceptance requestedCount must be a positive integer");
  }
  if (value.requireExhaustion !== undefined && typeof value.requireExhaustion !== "boolean")
    throw new Error("Acceptance requireExhaustion must be boolean");
  if (value.allowEmpty !== undefined && typeof value.allowEmpty !== "boolean")
    throw new Error("Acceptance allowEmpty must be boolean");
}

export function resolveAcceptance(
  contract: TaskAcceptance,
  input: Record<string, unknown>,
): BatchAcceptance {
  const requestedCount =
    typeof contract.requestedCount === "object"
      ? field(input, contract.requestedCount.input)
      : contract.requestedCount;
  if (requestedCount !== undefined && typeof requestedCount !== "number")
    throw new Error("Acceptance requestedCount must be a positive integer");
  const { requestedCount: _requested, ...rest } = contract;
  const resolved: BatchAcceptance = {
    ...rest,
    ...(requestedCount === undefined ? {} : { requestedCount }),
  };
  if (typeof contract.requestedCount === "object" && requestedCount === undefined)
    throw new Error(`Missing requested count input ${contract.requestedCount.input}`);
  validateAcceptance(resolved);
  return resolved;
}

/** Called before committing a record; rejected values never become completed items. */
export function validateRecord(record: unknown, contract: BatchAcceptance): string {
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error("Extracted record must be an object");
  for (const key of contract.requiredFields) {
    const value = field(record, key);
    if (value === undefined || value === null || (typeof value === "string" && !value.trim()))
      throw new Error(`Record is missing required field ${key}`);
  }
  const id = field(record, contract.idField);
  if ((typeof id !== "string" || !id.trim()) && (typeof id !== "number" || !Number.isFinite(id)))
    throw new Error(`Record has invalid ID at ${contract.idField}`);
  const url = field(record, contract.sourceUrlField);
  if (typeof url !== "string")
    throw new Error(`Record is missing source URL ${contract.sourceUrlField}`);
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("protocol");
  } catch {
    throw new Error(`Record has invalid source URL at ${contract.sourceUrlField}`);
  }
  return String(id);
}

export function assessTask(
  value: unknown,
  contract: TaskAcceptance | undefined,
  input: Record<string, unknown>,
  options: { success: boolean; interrupted?: boolean; error?: string; outputPaths?: string[] },
): TaskAssessment {
  const outputPaths = options.outputPaths ?? [];
  if (!options.success)
    return {
      status: options.interrupted ? "interrupted" : "failed",
      collected: 0,
      failedItems: 0,
      terminationReason: options.interrupted ? "interrupted" : "execution-failed",
      errors: [options.error ?? "Execution did not succeed"],
      outputPaths,
      verification: "unverified",
    };
  if (!contract)
    return {
      status: "incomplete",
      collected: 0,
      failedItems: 0,
      terminationReason: "unverified",
      errors: ["Execution succeeded without a deterministic task acceptance contract"],
      outputPaths,
      verification: "unverified",
    };
  const resolved = resolveAcceptance(contract, input);
  const records = contract.recordsPath ? field(value, contract.recordsPath) : value;
  const termination = field(value, contract.terminationPath);
  const errors: string[] = [];
  const ids = new Set<string>();
  let invalid = 0;
  if (!Array.isArray(records)) errors.push("Task result is missing its records array");
  else
    for (const record of records) {
      try {
        const id = validateRecord(record, resolved);
        if (ids.has(id)) throw new Error(`Duplicate record ID ${id}`);
        ids.add(id);
      } catch (error) {
        invalid++;
        if (errors.length < 20) errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  const collected = ids.size;
  if (!collected && !resolved.allowEmpty) errors.push("No valid records collected");
  if (resolved.requestedCount !== undefined && collected !== resolved.requestedCount)
    errors.push(`Requested ${resolved.requestedCount} records, collected ${collected}`);
  if (termination !== "requested-count" && termination !== "source-exhausted")
    errors.push("Collection lacks an explicit termination reason");
  if (termination === "requested-count" && resolved.requestedCount === undefined)
    errors.push("Requested-count termination requires an explicit requested count");
  if (
    (resolved.requireExhaustion || resolved.requestedCount === undefined) &&
    termination !== "source-exhausted"
  )
    errors.push("Source exhaustion was not established");
  return {
    status: errors.length ? "incomplete" : "complete",
    collected,
    failedItems: invalid,
    terminationReason: typeof termination === "string" ? termination : "unknown",
    errors,
    outputPaths,
    verification: "deterministic",
  };
}

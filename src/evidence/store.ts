import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { withKeyedLock } from "../persist/lock.js";
import type { ActionCase, ActionCaseStore } from "./types.js";

export interface Retention {
  perAction: number;
  totalBytes: number;
  maxAgeMs: number;
}
export const DEFAULT_RETENTION: Retention = {
  perAction: 20,
  totalBytes: 5_000_000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
};
export function retainCases(
  cases: ActionCase[],
  limits: Retention,
  now = Date.now(),
): ActionCase[] {
  const counts = new Map<string, number>();
  const fingerprints = new Set<string>();
  let bytes = 0;
  return [...cases]
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .filter((record) => {
      const size = Buffer.byteLength(JSON.stringify(record));
      const key = `${record.actionId}:${record.contractFingerprint}:${record.implementationVersion}:${record.fingerprint}`;
      if (
        record.capturedAt < now - limits.maxAgeMs ||
        (counts.get(record.actionId) ?? 0) >= limits.perAction ||
        bytes + size > limits.totalBytes ||
        fingerprints.has(key)
      )
        return false;
      counts.set(record.actionId, (counts.get(record.actionId) ?? 0) + 1);
      fingerprints.add(key);
      bytes += size;
      return true;
    });
}
export function createCaseStore(
  path?: string,
  limits: Retention = DEFAULT_RETENTION,
  failureArchive = false,
): ActionCaseStore {
  let memory: ActionCase[] = [];
  const read = async (): Promise<ActionCase[]> => {
    if (!path) return memory;
    try {
      const record = JSON.parse(await readFile(path, "utf8"));
      if (record.schemaVersion !== 1 || !Array.isArray(record.cases))
        throw new Error("Unsupported action case storage version");
      return record.cases;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const persist = async (cases: ActionCase[]) => {
    if (!path) {
      memory = structuredClone(cases);
      return;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, cases }), { mode: 0o600 });
    await rename(temporary, path);
  };
  const list = async (actionId: string) => {
    const prune = async () => {
      const records = await read();
      const cases = retainCases(records, limits);
      if (cases.length !== records.length) await persist(cases);
      return structuredClone(cases.filter((record) => record.actionId === actionId));
    };
    return path ? withKeyedLock(path, prune) : prune();
  };
  return {
    ...(failureArchive
      ? {}
      : {
          saveFailure: async (record: import("./types.js").FailedActionCase) => {
            if (path) await createCaseStore(`${path}.failures`, limits, true).save(record);
          },
        }),
    list,
    async inspect(actionId) {
      const cases = await list(actionId);
      return {
        cases: cases.length,
        bytes: Buffer.byteLength(JSON.stringify(cases)),
        incomplete: cases.filter(
          (record) =>
            !record.before.complete ||
            !record.after.complete ||
            !record.inputsComplete ||
            record.before.redacted,
        ).length,
      };
    },
    async save(record) {
      if (!failureArchive && "failure" in record)
        throw new Error("Failure evidence cannot be stored as a successful case");
      if (record.schemaVersion !== 1) throw new Error("Unsupported action case version");
      const save = async () => {
        const cases = retainCases([record, ...(await read())], limits);
        await persist(cases);
      };
      if (path) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await withKeyedLock(path, save);
      } else await save();
    },
  };
}

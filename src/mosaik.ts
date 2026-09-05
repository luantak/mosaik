import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryRegistry } from "./capabilities/lookup.js";
import type { RepairAgent } from "./agents/types.js";
import { parseActionSource } from "./library/action-source.js";
import { parseAutomationImports } from "./library/automation-imports.js";
import { normalizeAutomationModule } from "./library/automation-module.js";
import { runAutomation } from "./automations/run.js";
import { validateAutomation } from "./automations/validate.js";
import type { AutomationExecutionResult } from "./automations/types.js";
import {
  openBrowserSession,
  type BrowserSession,
  type BrowserSessionOptions,
} from "./runtime/session.js";

export interface MosaikOptions extends BrowserSessionOptions {
  /** A supplied session remains owned by the caller. */
  session?: BrowserSession;
  startUrl?: string;
  timeoutMs?: number;
  maxActionCalls?: number;
  outputDirectory?: string;
  signal?: AbortSignal;
  /** Enable live repair with a caller-supplied agent. Defaults to false. */
  repair?: false | { agent: RepairAgent };
}

export interface Mosaik {
  /** Used by imported automation functions; callers normally invoke those functions directly. */
  execute(moduleUrl: string, input: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export class MosaikExecutionError extends Error {
  constructor(readonly result: AutomationExecutionResult) {
    super(result.error ?? "Automation execution failed");
    this.name = "MosaikExecutionError";
  }
}

/** Create one browser owner. Calls are serialized to avoid racing its browser state. */
export async function createMosaik(options: MosaikOptions = {}): Promise<Mosaik> {
  const session = options.session ?? (await openBrowserSession(options));
  const cache = new Map<string, { source: string; normalized: string }>();
  const actionCache = new Map<
    string,
    { source: string; action: ReturnType<typeof parseActionSource> }
  >();
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;

  async function execute(moduleUrl: string, input: Record<string, unknown>): Promise<unknown> {
    const entry = await realpath(fileURLToPath(moduleUrl));
    const automationDirectory = dirname(entry);
    if (basename(automationDirectory) !== "automations")
      throw new Error("Imported automations must live in a site's automations directory");
    const siteDirectory = dirname(automationDirectory);
    const sources = new Map<string, string>();
    const actions = new Map<string, ReturnType<typeof parseActionSource>>();
    const actionPaths = new Set<string>();
    const visiting = new Set<string>();

    async function resolveDependency(from: string, specifier: string): Promise<string> {
      let path = resolve(dirname(from), specifier);
      try {
        path = await realpath(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !path.endsWith(".js"))
          throw error;
        path = await realpath(path.slice(0, -3) + ".ts");
      }
      const within = relative(siteDirectory, path);
      if (within.startsWith("..") || isAbsolute(within))
        throw new Error("Automation import escapes its site directory");
      return path;
    }

    async function load(path: string, depth: number): Promise<void> {
      if (visiting.has(path)) throw new Error("Automation import cycle");
      if (depth > 1) throw new Error("Nested automation imports are limited to one level");
      visiting.add(path);
      const source = await readFile(path, "utf8");
      let cached = cache.get(path);
      if (cached?.source !== source) {
        const normalized = normalizeAutomationModule(source);
        validateAutomation(normalized);
        cached = { source, normalized };
        cache.set(path, cached);
      }
      sources.set(basename(path, extname(path)), cached.normalized);
      for (const dependency of parseAutomationImports(cached.normalized)) {
        if (dependency.kind !== "action" && dependency.kind !== "automation") continue;
        const target = await resolveDependency(path, dependency.specifier);
        if (dependency.kind === "automation") {
          await load(target, depth + 1);
          continue;
        }
        const source = await readFile(target, "utf8");
        let cachedAction = actionCache.get(target);
        if (cachedAction?.source !== source) {
          cachedAction = { source, action: parseActionSource(source) };
          actionCache.set(target, cachedAction);
        }
        const action = cachedAction.action;
        if (dependency.names.some((name) => name !== action.name))
          throw new Error("Action import must match its exported name");
        actions.set(action.id, action);
        actionPaths.add(target);
      }
      visiting.delete(path);
    }
    await load(entry, 0);
    const siteId = decodeURIComponent(basename(siteDirectory));
    if ([...actions.values()].some((action) => action.siteId !== siteId))
      throw new Error("Imported action belongs to a different site");
    const id = basename(entry, extname(entry));
    const registry = createMemoryRegistry([...actions.values()]);
    const result = await runAutomation(
      session,
      { id, siteId, version: 1, source: sources.get(id)! },
      {
        registry,
        ...(options.repair ? { agent: options.repair.agent } : {}),
        input,
        loadAutomationSource: async (id) => sources.get(id),
        ...(options.startUrl === undefined ? {} : { startUrl: options.startUrl }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxActionCalls === undefined ? {} : { maxActionCalls: options.maxActionCalls }),
        ...(options.outputDirectory === undefined
          ? {}
          : { outputDirectory: options.outputDirectory }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    // Keep accepted repairs for later calls, while source edits still invalidate the cache.
    for (const path of actionPaths) {
      const cached = actionCache.get(path)!;
      const repaired = await registry.get(cached.action.id);
      if (repaired && repaired.version > cached.action.version) cached.action = repaired;
    }
    if (!result.success) throw new MosaikExecutionError(result);
    return result.value;
  }

  return {
    execute(moduleUrl, input) {
      if (closed) return Promise.reject(new Error("Mosaik instance is closed"));
      // Snapshot inputs before a preceding call has finished.
      const snapshot = structuredClone(input);
      const pending = tail.then(() => execute(moduleUrl, snapshot));
      tail = pending.catch(() => undefined);
      return pending;
    },
    close() {
      closed = true;
      closing ??= tail.then(async () => {
        if (!options.session) await session.close();
      });
      return closing;
    },
  };
}

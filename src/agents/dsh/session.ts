import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AgentRunMetrics, TrajectoryEntry } from "../metrics.js";
import { billedInputTokens, parseDshUsage } from "../metrics.js";

export type DshReasoning = "low" | "medium" | "high";

export interface DshSessionEvent {
  nestedDiscovery?: boolean;
  type?: string;
  time?: number;
  data?: Record<string, unknown>;
}

export interface DshChildResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted?: boolean;
}

export interface DshChildControl {
  signal?: AbortSignal;
  eventRoot?: string;
  onEvent?: (event: DshSessionEvent) => void;
}

export function dshFailureReason(
  child: DshChildResult,
  values: unknown[],
  fallback: string,
): string {
  const toolError = values.findLast(
    (value): value is string =>
      typeof value === "string" && /(?:error|budget|refused|failed)/i.test(value),
  );
  if (toolError !== undefined) {
    if (!toolError.includes("\n")) return toolError;
    const prerequisite = toolError.match(/Discovery prerequisite [^\n]+/);
    if (prerequisite) return prerequisite[0];
    const cause = toolError
      .split("\n")
      .find((line) =>
        /^(?:HostActionError|Error): (?!code run failed|file:|dsh: plugin tree)/.test(line),
      );
    return cause ?? toolError.split("\n")[0] ?? toolError;
  }
  const stderr = child.stderr
    .split("\n")
    .filter((line) => !line.includes("ExperimentalWarning") && !line.startsWith("(Use `node"))
    .join("\n")
    .trim();
  return stderr || child.stdout.trim() || fallback;
}

export async function loadProjectEnv(projectRoot: string): Promise<void> {
  let source: string;
  try {
    source = await readFile(join(projectRoot, ".env"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function runDshChild(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  shouldStop?: () => Promise<boolean>,
  control: DshChildControl = {},
): Promise<DshChildResult> {
  return new Promise((resolve, reject) => {
    if (control.signal?.aborted === true) {
      reject(abortError(control.signal.reason));
      return;
    }
    const ownsProcessGroup = process.platform !== "win32" && env.MOSAIK_CHILD_PROCESS_GROUP !== "1";
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: ownsProcessGroup ? { ...env, MOSAIK_CHILD_PROCESS_GROUP: "1" } : env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: ownsProcessGroup,
    });
    let stdout = "";
    let stderr = "";
    let stopped = false;
    let aborted = false;
    let polling = false;
    let eventOffsets = new Map<string, number>();
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

    const killTree = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (ownsProcessGroup) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };

    const terminate = (fromAbort: boolean) => {
      if (stopped || aborted) return;
      if (fromAbort) aborted = true;
      else stopped = true;
      killTree("SIGTERM");
      forceKillTimer = setTimeout(() => killTree("SIGKILL"), 2_000);
    };

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        if (control.eventRoot !== undefined && control.onEvent !== undefined) {
          const batch = await loadDshEventsSince(control.eventRoot, eventOffsets);
          eventOffsets = batch.offsets;
          for (const event of batch.events) control.onEvent(event);
        }
        if (shouldStop !== undefined && (await shouldStop())) terminate(false);
      } catch {
        // Event files may be between writes. The next poll retries them.
      } finally {
        polling = false;
      }
    };

    const timer = setInterval(() => void poll(), 150);
    const onAbort = () => terminate(true);
    control.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      clearInterval(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      control.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      clearInterval(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      control.signal?.removeEventListener("abort", onAbort);
      void poll().finally(() => {
        resolve({
          stdout,
          stderr,
          exitCode: aborted ? 130 : stopped ? 0 : (code ?? 1),
          ...(aborted ? { aborted: true } : {}),
        });
      });
    });
  });
}

function abortError(reason: unknown): Error {
  const error = new Error(typeof reason === "string" ? reason : "Run cancelled");
  error.name = "AbortError";
  return error;
}

export async function loadDshEvents(root: string): Promise<DshSessionEvent[]> {
  const events: DshSessionEvent[] = [];
  for (const file of await findJsonl(root)) {
    const nestedDiscovery = relative(root, file).startsWith(`discovery${sep}`);
    events.push(...(await loadDshEventFile(file)).map((event) => ({ ...event, nestedDiscovery })));
  }
  return events;
}

async function loadDshEventsSince(
  root: string,
  offsets: ReadonlyMap<string, number>,
): Promise<{ events: DshSessionEvent[]; offsets: Map<string, number> }> {
  const events: DshSessionEvent[] = [];
  const nextOffsets = new Map(offsets);
  for (const file of await findJsonl(root)) {
    const fileEvents = await loadDshEventFile(file);
    const offset = Math.min(offsets.get(file) ?? 0, fileEvents.length);
    events.push(...fileEvents.slice(offset));
    nextOffsets.set(file, fileEvents.length);
  }
  events.sort((left, right) => (left.time ?? 0) - (right.time ?? 0));
  return { events, offsets: nextOffsets };
}

async function loadDshEventFile(file: string): Promise<DshSessionEvent[]> {
  const events: DshSessionEvent[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n").filter(Boolean)) {
    const event = JSON.parse(line) as DshSessionEvent;
    if (typeof event.type === "string") events.push(event);
  }
  return events;
}

export function analyzeAgentEvents(
  events: DshSessionEvent[],
  durationMs: number,
): {
  metrics: AgentRunMetrics;
  trajectory: TrajectoryEntry[];
  terminalValues: unknown[];
  nestedDiscoveryMs: number;
} {
  // Recursive session loading already contains discovery requests and usage.
  // Returned discoveryMetrics are only a fallback for logs without child events.
  const hasDiscoveryEvents = events.some((event) => event.nestedDiscovery === true);
  let headers = 0;
  let completions = 0;
  let codeExecutions = 0;
  let nestedToolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let nestedModelRequests = 0;
  let nestedCodeExecutions = 0;
  let nestedAgentToolCalls = 0;
  let nestedDiscoveryMs = 0;
  const trajectory: TrajectoryEntry[] = [];
  const terminalValues: unknown[] = [];
  const visibleTools: string[] = [];
  const sessionStartedAt = events
    .map((event) => event.time)
    .filter((time): time is number => typeof time === "number")
    .reduce((earliest, time) => Math.min(earliest, time), Number.POSITIVE_INFINITY);
  let firstActionMs: number | undefined;
  let firstActionKind: AgentRunMetrics["firstActionKind"];
  let firstBrowserActionMs: number | undefined;
  let firstBrowserActionKind: AgentRunMetrics["firstBrowserActionKind"];
  const dispatchStarts = new Map<string, number>();

  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === "tool/code-dispatch-start") {
      const dispatchId = dispatchKey(data);
      if (dispatchId !== undefined && event.time !== undefined) {
        dispatchStarts.set(dispatchId, event.time);
      }
      if (
        firstActionMs === undefined &&
        event.time !== undefined &&
        Number.isFinite(sessionStartedAt) &&
        isExplorationAction(data.name)
      ) {
        firstActionMs = Math.max(0, event.time - sessionStartedAt);
        firstActionKind = "discovery";
      }
    }
    if (event.type === "request/header") {
      headers += 1;
      const tools = Array.isArray(asRecord(data.header)?.tools)
        ? (asRecord(data.header)?.tools as unknown[])
        : [];
      for (const tool of tools) {
        const name = asRecord(tool)?.name;
        if (typeof name === "string" && !visibleTools.includes(name)) visibleTools.push(name);
      }
    }
    if (event.type === "assistant/message" && isModelMessage(data)) {
      completions += 1;
      trajectory.push({
        kind: "model-request",
        name: `request ${completions}`,
        arguments: { tools: visibleTools },
      });
      const usage = parseDshUsage(data.usage);
      if (usage !== undefined) {
        inputTokens += billedInputTokens(usage);
        outputTokens += usage.outputTokens;
      }
    }
    if (event.type === "tool/call" && data.name === "run_code") {
      codeExecutions += 1;
      trajectory.push({
        kind: "code-execution",
        name: "run_code",
        arguments: parseMaybeJson(data.arguments),
      });
    }
    if (event.type === "tool/result") {
      const value = parseToolResult(data);
      if (event.nestedDiscovery !== true) terminalValues.push(value);
      const pending = trajectory.findLast(
        (entry) => entry.kind === "code-execution" && entry.result === undefined,
      );
      if (pending !== undefined) pending.result = value;
    }
    if (event.type === "tool/code-dispatch") {
      nestedToolCalls += 1;
      const value = parseToolResult(data);
      if (data.name === "inspectNavigation" && firstBrowserActionMs === undefined) {
        const startedAt = asRecord(value)?.firstBrowserActionAt;
        if (
          typeof startedAt === "number" &&
          Number.isFinite(startedAt) &&
          Number.isFinite(sessionStartedAt)
        ) {
          firstBrowserActionMs = Math.max(0, startedAt - sessionStartedAt);
          firstBrowserActionKind = "planning-navigation";
        }
      }
      if (data.name === "discoverAction" || data.name === "prepareComposition") {
        const nested = discoveryMetrics(value);
        if (nested !== undefined) {
          if (!hasDiscoveryEvents) {
            nestedModelRequests += nested.modelRequests;
            nestedCodeExecutions += nested.codeExecutions;
            nestedAgentToolCalls += nested.nestedToolCalls;
            inputTokens += nested.inputTokens ?? 0;
            outputTokens += nested.outputTokens ?? 0;
          }
          nestedDiscoveryMs += nested.durationMs ?? 0;
          const dispatchStartedAt = dispatchStarts.get(dispatchKey(data) ?? "");
          if (
            firstActionMs === undefined &&
            nested.firstActionMs !== undefined &&
            dispatchStartedAt !== undefined &&
            Number.isFinite(sessionStartedAt)
          ) {
            firstActionMs = Math.max(
              0,
              dispatchStartedAt - sessionStartedAt + nested.firstActionMs,
            );
            firstActionKind = "discovery";
          }
          if (
            firstBrowserActionMs === undefined &&
            nested.firstBrowserActionMs !== undefined &&
            dispatchStartedAt !== undefined &&
            Number.isFinite(sessionStartedAt)
          ) {
            firstBrowserActionMs = Math.max(
              0,
              dispatchStartedAt - sessionStartedAt + nested.firstBrowserActionMs,
            );
            firstBrowserActionKind = "discovery-navigation";
          }
        }
      }
      if (event.nestedDiscovery !== true) terminalValues.push(value);
      trajectory.push({
        kind: "nested-tool",
        name: typeof data.name === "string" ? data.name : "unknown",
        arguments: parseMaybeJson(data.arguments),
        result: value,
      });
    }
  }

  return {
    metrics: {
      modelRequests: Math.max(headers, completions) + nestedModelRequests,
      codeExecutions: codeExecutions + nestedCodeExecutions,
      nestedToolCalls: nestedToolCalls + nestedAgentToolCalls,
      ...(inputTokens === 0 ? {} : { inputTokens }),
      ...(outputTokens === 0 ? {} : { outputTokens }),
      durationMs: Math.round(durationMs),
      repairSucceeded: false,
      ...(firstActionMs === undefined ? {} : { firstActionMs: Math.round(firstActionMs) }),
      ...(firstActionKind === undefined ? {} : { firstActionKind }),
      ...(firstBrowserActionMs === undefined
        ? {}
        : { firstBrowserActionMs: Math.round(firstBrowserActionMs) }),
      ...(firstBrowserActionKind === undefined ? {} : { firstBrowserActionKind }),
    },
    trajectory,
    terminalValues,
    nestedDiscoveryMs,
  };
}

function discoveryMetrics(value: unknown):
  | {
      modelRequests: number;
      codeExecutions: number;
      nestedToolCalls: number;
      inputTokens?: number;
      outputTokens?: number;
      durationMs?: number;
      firstActionMs?: number;
      firstBrowserActionMs?: number;
    }
  | undefined {
  const outer = asRecord(value);
  const actions = [
    asRecord(outer?.action),
    ...(Array.isArray(outer?.discovered) ? outer.discovered.map(asRecord) : []),
  ].filter((action): action is Record<string, unknown> => action !== undefined);
  const metrics = actions
    .map((action) => asRecord(action.discoveryMetrics))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .filter(
      (item) =>
        typeof item.modelRequests === "number" &&
        typeof item.codeExecutions === "number" &&
        typeof item.nestedToolCalls === "number",
    );
  if (metrics.length === 0) return undefined;
  const total = (key: "modelRequests" | "codeExecutions" | "nestedToolCalls") =>
    metrics.reduce((sum, item) => sum + (item[key] as number), 0);
  const optionalTotal = (key: "inputTokens" | "outputTokens" | "durationMs") => {
    const values = metrics
      .map((item) => item[key])
      .filter((item): item is number => typeof item === "number");
    return values.length === 0 ? undefined : values.reduce((sum, item) => sum + item, 0);
  };
  const inputTokens = optionalTotal("inputTokens");
  const outputTokens = optionalTotal("outputTokens");
  const durationMs = optionalTotal("durationMs");
  const firstActionMs = metrics[0]?.firstActionMs;
  const firstBrowserActionMs = metrics[0]?.firstBrowserActionMs;
  return {
    modelRequests: total("modelRequests"),
    codeExecutions: total("codeExecutions"),
    nestedToolCalls: total("nestedToolCalls"),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(typeof firstActionMs === "number" ? { firstActionMs } : {}),
    ...(typeof firstBrowserActionMs === "number" ? { firstBrowserActionMs } : {}),
  };
}

function dispatchKey(data: Record<string, unknown>): string | undefined {
  if (typeof data.subCallId === "string") return data.subCallId;
  return typeof data.name === "string" ? data.name : undefined;
}

function isExplorationAction(name: unknown): boolean {
  return name === "exploreFill" || name === "exploreClick" || name === "exploreSelect";
}

export function extractJsonObjects(text: string): unknown[] {
  const values: unknown[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    for (let end = start; end < text.length; end += 1) {
      if (text[end] === "{") depth += 1;
      if (text[end] === "}") depth -= 1;
      if (depth === 0) {
        const value = parseMaybeJson(text.slice(start, end + 1));
        if (asRecord(value) !== undefined) values.push(value);
        break;
      }
    }
  }
  return values;
}

async function findJsonl(root: string): Promise<string[]> {
  const nested = await Promise.all(
    (await readdir(root, { withFileTypes: true })).map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return findJsonl(path);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

function isModelMessage(data: Record<string, unknown>): boolean {
  return asRecord(asRecord(data.message)?.source)?.kind === "model";
}

function parseToolResult(data: Record<string, unknown>): unknown {
  const message = asRecord(data.message);
  const result = asRecord(data.result);
  const content = data.content ?? message?.content ?? result?.content;
  if (!Array.isArray(content)) return result?.value ?? data.value;
  return parseMaybeJson(extractText(content));
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      const block = asRecord(entry);
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      return extractText(block?.content);
    })
    .join("");
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface AgentRunMetrics {
  modelRequests: number;
  nestedToolCalls: number;
  codeExecutions: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  repairSucceeded: boolean;
  firstActionMs?: number;
  firstActionKind?: "discovery" | "automation";
  firstBrowserActionMs?: number;
  firstBrowserActionKind?: "discovery-navigation" | "automation-navigation" | "planning-navigation";
}

export interface TrajectoryEntry {
  kind: "model-request" | "code-execution" | "nested-tool";
  name: string;
  arguments?: unknown;
  result?: unknown;
}

export interface DshTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export function parseDshUsage(value: unknown): DshTokenUsage | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const inputTokens = numberField(record, "inputTokens");
  const outputTokens = numberField(record, "outputTokens");
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheReadTokens = numberField(record, "cacheReadTokens");
  const cacheWriteTokens = numberField(record, "cacheWriteTokens");
  const reasoningTokens = numberField(record, "reasoningTokens");
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

export function billedInputTokens(usage: DshTokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

export function usageFromSessionEvent(event: {
  type?: string;
  data?: Record<string, unknown>;
}): DshTokenUsage | undefined {
  const data = event.data ?? {};
  if (event.type === "assistant/message") return parseDshUsage(data.usage);
  if (event.type === "assistant/chunk") {
    const chunk = asRecord(data.chunk);
    if (chunk?.type === "usage") return parseDshUsage(chunk.usage);
  }
  return undefined;
}

export function automationSize(source: string): { lines: number; nodes: number } {
  const lines = source.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const calls = source.match(/ctx\.actions\.\w+/g)?.length ?? 0;
  const loops = source.match(/\bfor\b/g)?.length ?? 0;
  const branches = source.match(/\bif\b/g)?.length ?? 0;
  return { lines, nodes: calls + loops + branches };
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

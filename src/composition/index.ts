import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CapabilityCompositionAgent,
  CapabilityCompositionRequest,
  CapabilityCompositionResult,
  CompositionProgressEvent,
} from "../agents/types.js";

export const DEFAULT_COMPOSITION_BUDGETS: CapabilityCompositionRequest["budgets"] = {
  maxModelRequests: 30,
  maxRunCodeExecutions: 30,
  maxNestedToolCalls: 160,
  maxActionCalls: 1000,
  executionTimeoutMs: 180_000,
};

export const DEFAULT_COMPOSITION_SAFETY: CapabilityCompositionRequest["safety"] = {
  allowedActionSafety: ["read-only", "browser-local"],
  allowExternalSideEffects: false,
};

export async function composeAndRun(
  agent: CapabilityCompositionAgent,
  input: {
    task: string;
    siteId: string;
    startUrl: string;
    inputs?: Record<string, unknown>;
    automationId?: string;
    safety?: CapabilityCompositionRequest["safety"];
    budgets?: CapabilityCompositionRequest["budgets"];
    signal?: AbortSignal;
    onProgress?: (event: CompositionProgressEvent) => void;
    runDirectory?: string;
    outputDirectory?: string;
  },
): Promise<CapabilityCompositionResult> {
  if (input.task.trim().length === 0) throw new Error("Composition task is required");
  const result = await agent.compose(
    {
      task: input.task,
      siteId: input.siteId,
      startUrl: input.startUrl,
      inputs: input.inputs ?? inferTaskInputs(input.task),
      safety: input.safety ?? DEFAULT_COMPOSITION_SAFETY,
      budgets: input.budgets ?? DEFAULT_COMPOSITION_BUDGETS,
      ...(input.automationId === undefined ? {} : { automationId: input.automationId }),
    },
    {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      ...(input.runDirectory === undefined ? {} : { runDirectory: input.runDirectory }),
      ...(input.outputDirectory === undefined ? {} : { outputDirectory: input.outputDirectory }),
    },
  );
  await persistCompositionResult(result);
  return result;
}

async function persistCompositionResult(result: CapabilityCompositionResult): Promise<void> {
  if (result.runDirectory === undefined) return;
  await mkdir(result.runDirectory, { recursive: true });
  const path = join(result.runDirectory, "result.json");
  const temporaryPath = join(result.runDirectory, `.result-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export function inferTaskInputs(task: string): Record<string, unknown> {
  const patterns = [
    /\b(?:first|top|up to)\s+([\d,_]+)\b/i,
    /\b(?:scrape|collect|extract|save|export)\s+(?:the\s+)?([\d,_]+)\b/i,
  ];
  for (const pattern of patterns) {
    const raw = task.match(pattern)?.[1]?.replace(/[,_]/g, "");
    if (raw === undefined) continue;
    const requestedCount = Number(raw);
    if (Number.isSafeInteger(requestedCount) && requestedCount > 0) return { requestedCount };
  }
  return {};
}

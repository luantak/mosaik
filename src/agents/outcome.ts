import type { AgentRunMetrics, TrajectoryEntry } from "./metrics.js";
import type {
  CapabilityCompositionRequest,
  CapabilityCompositionResult,
  CompositionRunOptions,
} from "./types.js";

export interface TaskOutcome {
  status: "complete" | "incomplete";
  answer?: string;
  reason?: string;
}

export function parseTaskOutcome(value: unknown): TaskOutcome | undefined {
  if (!value || typeof value !== "object") return undefined;
  const outer = value as Record<string, unknown>;
  const unwrapped = outer.result ?? value;
  if (!unwrapped || typeof unwrapped !== "object") return undefined;
  const record = unwrapped as Record<string, unknown>;
  if (record.status === "complete" && typeof record.answer === "string" && record.answer.trim()) {
    return { status: "complete", answer: record.answer.trim() };
  }
  if (record.status === "incomplete" && typeof record.reason === "string" && record.reason.trim()) {
    return {
      status: "incomplete",
      reason: record.reason.trim(),
      ...(typeof record.answer === "string" && record.answer.trim()
        ? { answer: record.answer.trim() }
        : {}),
    };
  }
  return undefined;
}

export interface OutcomeReview {
  outcome: TaskOutcome;
  metrics: AgentRunMetrics;
  trajectory: TrajectoryEntry[];
}

// Review and recovery share the original request's budgets. Execution success is
// preserved separately so callers can distinguish missing evidence from a crash.
export async function completeTask(
  request: CapabilityCompositionRequest,
  options: CompositionRunOptions,
  execute: (
    request: CapabilityCompositionRequest,
    attempt: number,
    feedback?: string,
  ) => Promise<CapabilityCompositionResult>,
  review: (
    request: CapabilityCompositionRequest,
    result: CapabilityCompositionResult,
    attempt: number,
  ) => Promise<OutcomeReview>,
): Promise<CapabilityCompositionResult> {
  const started = performance.now();
  const used = {
    modelRequests: 0,
    codeExecutions: 0,
    nestedToolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
  };
  let actionCalls = 0;
  const attempts: NonNullable<CapabilityCompositionResult["attempts"]> = [];
  const timings = {
    agentMs: 0,
    outerCompositionMs: 0,
    outcomeReviewMs: 0,
    nestedDiscoveryMs: 0,
    deterministicExecutionMs: 0,
    hostOverheadMs: 0,
  };
  const trajectory: TrajectoryEntry[] = [];
  let feedback: string | undefined;
  const seenEvidence = new Set<string>();
  let result!: CapabilityCompositionResult;
  const remaining = (): CapabilityCompositionRequest => ({
    ...request,
    budgets: {
      ...request.budgets,
      maxModelRequests: Math.max(0, request.budgets.maxModelRequests - used.modelRequests),
      maxRunCodeExecutions: Math.max(0, request.budgets.maxRunCodeExecutions - used.codeExecutions),
      maxNestedToolCalls: Math.max(0, request.budgets.maxNestedToolCalls - used.nestedToolCalls),
      maxActionCalls: Math.max(0, request.budgets.maxActionCalls - actionCalls),
    },
  });
  const add = (metrics: AgentRunMetrics, entries: TrajectoryEntry[]) => {
    for (const key of Object.keys(used) as (keyof typeof used)[]) used[key] += metrics[key] ?? 0;
    trajectory.push(...entries);
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    options.signal?.throwIfAborted();
    result = await execute(remaining(), attempt, feedback);
    add(result.metrics, result.trajectory);
    for (const key of Object.keys(timings) as (keyof typeof timings)[])
      timings[key] += result.metrics.timings?.[key] ?? 0;
    actionCalls += result.execution?.actionCalls.length ?? 0;
    if (result.status !== "completed") break;
    let assessment: TaskOutcome;
    const budget = remaining().budgets;
    if (
      budget.maxModelRequests < 1 ||
      budget.maxRunCodeExecutions < 1 ||
      budget.maxNestedToolCalls < 1
    ) {
      assessment = {
        status: "incomplete",
        reason:
          "Execution succeeded, but the budget was exhausted before task outcome verification.",
      };
    } else {
      options.onProgress?.({ kind: "status", message: "Checking the task outcome" });
      try {
        const checked = await review(remaining(), result, attempt);
        add(checked.metrics, checked.trajectory);
        timings.agentMs += checked.metrics.durationMs;
        timings.outcomeReviewMs += checked.metrics.durationMs;
        assessment = checked.outcome;
      } catch (error) {
        options.signal?.throwIfAborted();
        assessment = {
          status: "incomplete",
          reason: `Task outcome verification failed: ${error instanceof Error ? error.message : String(error)}`,
        };
        result = { ...result, status: "failed", outcome: assessment, reason: assessment.reason! };
        break;
      }
      if (
        used.modelRequests > request.budgets.maxModelRequests ||
        used.codeExecutions > request.budgets.maxRunCodeExecutions ||
        used.nestedToolCalls > request.budgets.maxNestedToolCalls
      ) {
        assessment = {
          status: "incomplete",
          reason: "Task outcome verification exceeded the agent budget.",
        };
      }
    }
    result = {
      ...result,
      outcome: assessment,
      status: assessment.status === "complete" ? "completed" : "failed",
      ...(assessment.answer === undefined ? {} : { answer: assessment.answer }),
      ...(assessment.reason === undefined ? {} : { reason: assessment.reason }),
    };
    attempts.push({
      execution: result.execution,
      outcome: assessment,
      automation: result.automation,
    });
    if (assessment.status === "complete") break;
    // Never replay external side effects or actions whose safety is unknown.
    const attemptedActionNames = [
      ...(result.execution?.actionCalls.map((call) => call.name) ?? []),
      ...(result.execution?.origin === "discovery"
        ? (result.execution.discoveryObservations ?? []).flatMap(discoveryObservationName)
        : []),
    ];
    const replayable =
      (result.execution?.origin !== "discovery" || attemptedActionNames.length > 0) &&
      attemptedActionNames.every((name) =>
        result.actionsConsidered.some(
          (action) =>
            action.name === name &&
            (result.execution?.origin === "discovery"
              ? action.safety === "read-only"
              : action.safety !== "external-side-effect"),
        ),
      );
    const evidenceKey = JSON.stringify({
      value: result.execution?.value,
      actionResults: result.execution?.actionResults,
      pageNavigation: result.execution?.pageNavigation,
    });
    const repeatedEvidence = seenEvidence.has(evidenceKey);
    seenEvidence.add(evidenceKey);
    const left = remaining().budgets;
    if (
      attempt === 3 ||
      repeatedEvidence ||
      !replayable ||
      left.maxModelRequests < 2 ||
      left.maxRunCodeExecutions < 2 ||
      left.maxNestedToolCalls < 2 ||
      left.maxActionCalls < 1
    )
      break;
    feedback = JSON.stringify({
      missingOutcome: assessment.reason,
      attemptedActions: attemptedActionNames,
      observedNavigation: result.execution?.pageNavigation,
      previousAutomation: result.automation?.source,
      executionEvidence: boundedEvidence({
        pageNavigation: result.execution?.pageNavigation,
        ...result.execution,
      }),
    });
    options.onProgress?.({ kind: "status", message: "Recovering missing task evidence" });
  }
  const totalMs = Math.round(performance.now() - started);
  return {
    ...result,
    attempts,
    trajectory,
    metrics: {
      ...result.metrics,
      ...used,
      ...(result.metrics.timings === undefined
        ? {}
        : { timings: { ...result.metrics.timings, ...timings, totalMs } }),
    },
  };
}

function discoveryObservationName(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? [name] : [];
}

export function boundedEvidence(value: unknown): unknown {
  const seen = new Map<string, string>();
  const compact = (item: unknown, path: string): unknown => {
    if (typeof item === "string" && item.length > 1000) {
      const previous = seen.get(item);
      if (previous !== undefined) return { sameAs: previous };
      seen.set(item, path);
    }
    if (Array.isArray(item)) return item.map((child, index) => compact(child, `${path}/${index}`));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          key,
          compact(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`),
        ]),
      );
    return item;
  };
  const deduplicated = compact(value, "");
  const text = JSON.stringify(deduplicated) ?? "null";
  return text.length <= 60000 ? deduplicated : { truncated: true, prefix: text.slice(0, 60000) };
}

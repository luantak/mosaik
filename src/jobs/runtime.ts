import { setTimeout as delay } from "node:timers/promises";
import type { SiteActionDefinition } from "../capabilities/types.js";
import { classify } from "../core/classify.js";
import { resolveStepValue } from "../core/types.js";
import {
  validateAcceptance,
  validateRecord,
  type TaskAssessment,
} from "../automations/acceptance.js";
import { HostActionError } from "../automations/types.js";
import { DurableJob } from "./store.js";
import type { BatchConfiguration, BatchPage, BatchWork, JobSummary } from "./types.js";

export function assertDurableActions(actions: SiteActionDefinition[]): void {
  for (const action of actions) {
    if (action.safety === "external-side-effect")
      throw new Error(`Durable extraction refuses external side effects: ${action.name}`);
    for (const implementation of action.implementations ?? [action.implementation])
      for (const step of implementation.steps)
        if (
          step.safety === "external-side-effect" ||
          ![
            "navigate",
            "extract-text",
            "extract-list",
            "click",
            "fill",
            "select",
            "hover",
          ].includes(step.type)
        )
          throw new Error(`Durable extraction refuses unsafe or non-replayable step ${step.id}`);
  }
}

/** Host-owned state, independent of the worker's success/error claims. */
export class BatchRuntime {
  private configuration: BatchConfiguration | undefined;
  private current: BatchWork | undefined;
  private navigated = false;
  private awaitingNavigation = false;
  private extracted = false;
  private lastError: unknown;
  private closed = false;
  private fatal: Error | undefined;
  constructor(
    readonly job: DurableJob,
    private readonly signal?: AbortSignal,
  ) {}

  beforeAction(action: SiteActionDefinition, args: unknown): void {
    this.check();
    if (!this.current)
      throw this.refuse("Durable browser actions must run inside list/extract callbacks");
    assertDurableActions([action]);
    if (!this.navigated) {
      // Every alternative must restore state; selecting a browser-dependent implementation
      // cannot silently make an unfinished item depend on the previous item's page.
      for (const implementation of action.implementations ?? [action.implementation]) {
        const first = implementation.steps[0];
        if (first?.type !== "navigate")
          throw this.refuse(
            "Each durable page/item must begin with an absolute deterministic navigation action",
          );
        const url = resolveStepValue(first.url, (args ?? {}) as Record<string, unknown>);
        if (!["http:", "https:"].includes(new URL(url).protocol))
          throw this.refuse("Durable navigation must use an absolute http(s) URL");
      }
      this.awaitingNavigation = true;
    }
  }

  actionSucceeded(action: SiteActionDefinition): void {
    if (this.awaitingNavigation) this.navigated = true;
    this.awaitingNavigation = false;
    if (
      (action.implementations ?? [action.implementation]).some((implementation) =>
        implementation.steps.some(
          (step) => step.type === "extract-text" || step.type === "extract-list",
        ),
      )
    )
      this.extracted = true;
    this.lastError = undefined;
  }
  actionFailed(error: unknown): void {
    this.awaitingNavigation = false;
    this.lastError = error;
  }

  bindings() {
    return {
      configure: async (request: unknown) => {
        this.check();
        if (this.configuration) throw this.refuse("Only one batch is supported per execution");
        const configuration = request as BatchConfiguration;
        validateAcceptance(configuration.acceptance);
        this.job.configure(configuration);
        this.configuration = configuration;
        return null;
      },
      next: async () => {
        this.check();
        if (!this.configuration) throw this.refuse("Batch is not configured");
        if (this.current)
          throw this.refuse("Previous durable work has not been committed or failed");
        const work = this.job.next();
        if (work.kind === "done") return { ...work, summary: this.job.export() };
        if (work.kind !== "wait") {
          this.current = work;
          this.navigated = false;
          this.extracted = false;
          this.lastError = undefined;
        }
        return work;
      },
      wait: async (request: unknown) => {
        this.check();
        const ms = (request as { delayMs: number }).delayMs;
        if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) throw this.refuse("Invalid retry delay");
        await delay(ms, undefined, this.signal ? { signal: this.signal } : {});
        return null;
      },
      page: async (request: unknown) => {
        this.check();
        const { work, page } = request as { work: BatchWork; page: BatchPage };
        this.assertCurrent(work);
        this.assertObserved();
        if (work.kind !== "page") throw this.refuse("Expected page work");
        this.job.page(work, page);
        this.current = undefined;
        // Export a bounded-memory snapshot each page, plus on finish/interruption.
        this.job.export();
        return null;
      },
      commit: async (request: unknown) => {
        this.check();
        const { work, record } = request as { work: BatchWork; record: unknown };
        this.assertCurrent(work);
        this.assertObserved();
        if (work.kind !== "item") throw this.refuse("Expected item work");
        const id = validateRecord(record, this.configuration!.acceptance);
        this.job.commit(work, record, id);
        this.current = undefined;
        return null;
      },
      fail: async (request: unknown) => {
        this.check();
        const { work, error } = request as { work: BatchWork; error: string };
        this.assertCurrent(work);
        const failure =
          this.lastError instanceof HostActionError ? this.lastError.failure : undefined;
        const category = failure ? classify(failure).category : undefined;
        const retryable = category === "infra" || category === "retryable";
        this.job.fail(work, String(error), retryable);
        this.current = undefined;
        if (
          failure?.error.type === "uncertain-outcome" ||
          failure?.error.type === "authentication-failed"
        )
          throw this.refuse(`Durable extraction stopped: ${failure.error.type}`);
        return null;
      },
    };
  }

  finish(success: boolean, error?: string, interrupted = false): JobSummary {
    this.closed = true;
    if (!success || this.current || !this.configuration) {
      if (interrupted) this.job.interrupt(error ?? "Execution interrupted");
      else this.job.finish("error", error ?? "Automation ended before durable work completed");
    }
    return this.job.export();
  }

  private assertObserved(): void {
    if (!this.navigated || !this.extracted)
      throw this.refuse(
        "Durable work requires deterministic navigation and observed extraction before commit",
      );
  }
  private assertCurrent(work: BatchWork): void {
    if (!this.current || JSON.stringify(work) !== JSON.stringify(this.current))
      throw this.refuse("Durable work does not match the active persisted attempt");
  }
  private check(): void {
    if (this.closed) throw new Error("Durable execution has ended");
    if (this.fatal) throw this.fatal;
    this.signal?.throwIfAborted();
  }
  private refuse(message: string): Error {
    this.fatal = new Error(message);
    return this.fatal;
  }
}

export function assessJob(summary: JobSummary): TaskAssessment {
  return {
    status: summary.status === "running" ? "incomplete" : summary.status,
    collected: summary.collected,
    failedItems: summary.failed,
    terminationReason: summary.termination ?? "unknown",
    errors: summary.reason ? [summary.reason] : [],
    outputPaths: [summary.outputPath, summary.failuresPath, summary.databasePath],
    verification: "deterministic",
  };
}

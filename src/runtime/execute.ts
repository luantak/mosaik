import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import {
  classify,
  hasLocator,
  promoteVerificationOnSuccess,
  recordFailedRun,
  recordSuccessfulRun,
  resolveStepValue,
  RunLog,
  type Action,
  type Automation,
  type AutomationFailure,
  type FailureClassification,
  type FailureEvidence,
  type FailureType,
  type LocatorDefinition,
  type Step,
} from "../core/index.js";
import {
  attachPageCollectors,
  captureFailureArtifacts,
  type CapturedArtifacts,
} from "./artifacts.js";
import { withIsolatedContext } from "./browser.js";
import { ConditionError, captureBefore, waitCondition } from "./conditions.js";
import { bindLocator, locatorLabel, resolveLocator } from "./locators.js";
import { collectOverview } from "./overview.js";
import { isBrowserSession, type BrowserSession } from "./session.js";
import {
  humanizedClick,
  humanizedFill,
  humanizedSelectOption,
  isPageHumanized,
  wasHumanizedClickDispatched,
  withHumanizedWait,
} from "./humanize.js";

export const DEFAULT_STEP_TIMEOUT_MS = 1_500;
export const HUMANIZED_STEP_TIMEOUT_ALLOWANCE_MS = 1_000;

export interface AutomationRunResult {
  success: boolean;
  runId: string;
  events: ReturnType<RunLog["emit"]>[];
  automation: Automation;
  outputs: Record<string, string>;
  halted?: boolean;
  failure?: AutomationFailure;
  classification?: FailureClassification;
}

export interface AutomationRunOptions {
  runDirectory?: string;
  timeoutMs?: number;
  inputs?: Record<string, unknown>;
  haltBefore?: (step: Step) => boolean;
}

export async function executeAutomation(
  browser: Browser | BrowserSession,
  automation: Automation,
  options: AutomationRunOptions = {},
): Promise<AutomationRunResult> {
  const runId = randomUUID();
  const log = new RunLog(runId);
  const timeoutMs =
    options.timeoutMs ??
    (isBrowserSession(browser) ? browser.defaultStepTimeoutMs : undefined) ??
    DEFAULT_STEP_TIMEOUT_MS;
  log.emit("run.started", { automationId: automation.id, version: automation.version });

  const outputs: Record<string, string> = {};
  const runInContext = <T>(run: (page: Page) => Promise<T>) =>
    isBrowserSession(browser) ? browser.withPage(run) : withIsolatedContext(browser, run);
  const result = await runInContext(async (page) => {
    const collectors = attachPageCollectors(page);
    for (const action of automation.actions) {
      for (const step of action.steps) {
        if (options.haltBefore?.(step) === true) {
          log.emit("run.finished", {
            outcome: "success",
            halted: true,
            haltedStepId: step.id,
          });
          return {
            success: true,
            halted: true,
            runId,
            events: log.events,
            automation,
            outputs,
          };
        }
        log.emit("step.started", { actionId: action.id, stepId: step.id, stepType: step.type });
        const stepTimeoutMs =
          isPageHumanized(page) && options.timeoutMs === undefined
            ? timeoutMs + HUMANIZED_STEP_TIMEOUT_ALLOWANCE_MS
            : timeoutMs;
        const outcome = await executeStep(page, step, stepTimeoutMs, options.inputs);
        if (outcome.ok) {
          if (outcome.output !== undefined) {
            outputs[outcome.output.key] =
              typeof outcome.output.value === "string"
                ? outcome.output.value
                : JSON.stringify(outcome.output.value);
          }
          log.emit("step.succeeded", {
            actionId: action.id,
            stepId: step.id,
            ...(outcome.output === undefined
              ? {}
              : { output: outcome.output.key, value: outcome.output.value }),
          });
          continue;
        }

        const directory =
          options.runDirectory === undefined ? undefined : join(options.runDirectory, runId);
        if (directory !== undefined) await mkdir(directory, { recursive: true });
        const artifacts =
          directory === undefined
            ? await (async (): Promise<CapturedArtifacts> => {
                const overview = await collectOverview(page);
                return {
                  consoleLogs: collectors.consoleLogs,
                  networkErrors: collectors.networkErrors,
                  overviewText: overview.text,
                  similarNames: overview.interactive
                    .map((item) => item.name)
                    .filter((name): name is string => name !== undefined),
                };
              })()
            : await captureFailureArtifacts(page, directory, collectors);

        const evidence: FailureEvidence = {
          ...outcome.evidence,
          ...(artifacts.similarNames.length === 0 ? {} : { similarNames: artifacts.similarNames }),
        };
        const failure: AutomationFailure = {
          runId,
          automationId: automation.id,
          actionId: action.id,
          stepId: step.id,
          step,
          error: { type: outcome.type, message: outcome.message },
          page: await pageInfo(page),
          artifacts: {
            ...(artifacts.screenshot === undefined ? {} : { screenshot: artifacts.screenshot }),
            ...(artifacts.accessibilitySnapshot === undefined
              ? {}
              : { accessibilitySnapshot: artifacts.accessibilitySnapshot }),
            ...(artifacts.overviewText.length === 0
              ? {}
              : { overviewText: artifacts.overviewText }),
            consoleLogs: artifacts.consoleLogs,
            networkErrors: artifacts.networkErrors,
          },
          ...(Object.keys(evidence).length === 0 ? {} : { evidence }),
        };
        const classification = classify(failure);
        log.emit("step.failed", {
          actionId: action.id,
          stepId: step.id,
          failureType: failure.error.type,
          message: failure.error.message,
        });
        log.emit("failure.classified", {
          category: classification.category,
          reason: classification.reason,
        });
        if (directory !== undefined) {
          await writeFile(
            join(directory, "run.events.jsonl"),
            `${log.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
          );
          await writeFile(join(directory, "failure.json"), JSON.stringify(failure, null, 2));
        }
        log.emit("run.finished", { outcome: "failed" });
        return {
          success: false,
          runId,
          events: log.events,
          automation: recordFailedRun(automation),
          outputs,
          failure,
          classification,
        };
      }
    }
    const promoted = promoteVerificationOnSuccess(automation);
    if (promoted.changed) {
      log.emit("automation.verification.changed", {
        from: promoted.from,
        to: promoted.to,
      });
    }
    log.emit("run.finished", { outcome: "success" });
    return {
      success: true,
      runId,
      events: log.events,
      automation: recordSuccessfulRun(promoted.automation),
      outputs,
    };
  });

  return result;
}

export async function replayPrerequisites(
  page: Page,
  action: Action,
  stepIndex: number,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  inputs?: Record<string, unknown>,
): Promise<void> {
  for (const step of action.steps.slice(0, stepIndex)) {
    const outcome = await executeStep(page, step, timeoutMs, inputs);
    if (!outcome.ok) {
      throw new Error(`Prerequisite ${step.id} failed: ${outcome.message}`);
    }
  }
}

export async function executeStep(
  page: Page,
  step: Step,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  inputs?: Record<string, unknown>,
): Promise<StepOutcome> {
  try {
    // Resolve every input before reading or mutating the browser.
    if (hasLocator(step)) step = { ...step, locator: bindLocator(step.locator, inputs) };
    if (step.type === "fill" || step.type === "select")
      step = { ...step, value: resolveStepValue(step.value, inputs) };
    if (step.type === "extract-list") {
      step = {
        ...step,
        fields: Object.fromEntries(
          Object.entries(step.fields).map(([key, field]) => [
            key,
            field.locator === undefined
              ? field
              : { ...field, locator: bindLocator(field.locator, inputs) },
          ]),
        ),
      };
    }
    const bound = inputs ?? {};
    const before = await captureBefore(page, step.completion, bound);
    if (step.ready !== undefined)
      await waitCondition(
        page,
        step.type === "extract-list" && step.empty
          ? { kind: "any", conditions: [step.ready, step.empty] }
          : step.ready,
        bound,
        step.conditionTimeoutMs ?? timeoutMs,
      );
    const outcome = await executeStepOperation(page, step, timeoutMs, inputs);
    if (outcome.ok && step.completion !== undefined) {
      try {
        await waitCondition(
          page,
          step.completion,
          bound,
          step.conditionTimeoutMs ?? timeoutMs,
          before,
        );
      } catch (error) {
        if (step.type === "click")
          return {
            ok: false,
            type: "uncertain-outcome",
            actionPerformed: true,
            message: `Click completed but result is unconfirmed: ${String(error)}`,
          };
        throw error;
      }
    }
    return outcome;
  } catch (error) {
    if (error instanceof ConditionError)
      return { ok: false, type: error.type, message: error.message };
    if (error instanceof Error && /Missing input:/.test(error.message))
      return { ok: false, type: "invalid-input", message: error.message };
    return diagnose(page, step, error);
  }
}

async function executeStepOperation(
  page: Page,
  step: Step,
  timeoutMs: number,
  inputs?: Record<string, unknown>,
): Promise<StepOutcome> {
  try {
    switch (step.type) {
      case "navigate": {
        const target = resolveStepValue(step.url, inputs);
        const url = /^[a-z]+:\/\//i.test(target) ? target : new URL(target, page.url()).href;
        const response = await withHumanizedWait(page, () =>
          page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
          }),
        );
        const status = response?.status();
        if (status !== undefined && status >= 500) {
          return {
            ok: false,
            type: "external-service-error",
            message: `HTTP ${status}`,
            evidence: { httpStatus: status },
          };
        }
        if (status !== undefined && status >= 400) {
          return {
            ok: false,
            type: "navigation-failed",
            message: `HTTP ${status}`,
            evidence: { httpStatus: status },
          };
        }
        return { ok: true };
      }
      case "click": {
        const target = resolveLocator(page, step.locator);
        if (!isPageHumanized(page)) await target.click({ timeout: timeoutMs, trial: true });
        try {
          if (isPageHumanized(page)) await humanizedClick(page, target, { timeout: timeoutMs });
          else await target.click({ timeout: timeoutMs });
        } catch (error) {
          if (isPageHumanized(page) && !wasHumanizedClickDispatched(error)) throw error;
          return {
            ok: false,
            type: "uncertain-outcome",
            actionPerformed: true,
            message: `Click was attempted; outcome is unknown: ${String(error)}`,
          };
        }
        return { ok: true };
      }
      case "fill":
        await humanizedFill(
          page,
          resolveLocator(page, step.locator),
          resolveStepValue(step.value, inputs),
          {
            timeout: timeoutMs,
          },
        );
        return { ok: true };
      case "select":
        await humanizedSelectOption(
          page,
          resolveLocator(page, step.locator),
          resolveStepValue(step.value, inputs),
          {
            timeout: timeoutMs,
          },
        );
        return { ok: true };
      case "extract-text": {
        const value = (
          await resolveLocator(page, step.locator).innerText({ timeout: timeoutMs })
        ).trim();
        return { ok: true, output: { key: step.output, value } };
      }
      case "extract-list": {
        const items = resolveLocator(page, step.locator);
        const rowFields = Object.values(step.fields).every(
          (field) => field.locator === undefined || sameLocator(field.locator, step.locator),
        );
        const snapshot = rowFields
          ? await items.evaluateAll((elements, fields) => {
              const rows: Record<string, unknown>[] = [];
              for (const [index, element] of elements.entries()) {
                const row: Record<string, unknown> = {};
                for (const [key, field] of Object.entries(fields)) {
                  const raw =
                    field.source === "text"
                      ? ((element as HTMLElement).innerText ?? element.textContent ?? "").trim()
                      : element.getAttribute(field.name);
                  if (raw === null) {
                    if (field.optional) continue;
                    return {
                      count: elements.length,
                      rows,
                      error: `Row ${index} field ${key} is missing attribute ${field.source === "text" ? "" : field.name}`,
                    };
                  }
                  row[key] =
                    field.source === "url"
                      ? (field.name === "src" &&
                          "currentSrc" in element &&
                          (element as HTMLImageElement).currentSrc) ||
                        new URL(raw, element.ownerDocument.baseURI).href
                      : raw;
                }
                rows.push(row);
              }
              return { count: elements.length, rows };
            }, step.fields)
          : undefined;
        const count = snapshot?.count ?? (await items.count());
        if (count === 0 && step.empty !== undefined) {
          await waitCondition(page, step.empty, inputs ?? {}, step.conditionTimeoutMs ?? timeoutMs);
          return { ok: true, output: { key: step.output, value: [] } };
        }
        if (count === 0) {
          return {
            ok: false,
            type: step.ready ? "condition-failed" : "locator-not-found",
            message: `${locatorLabel(step.locator)} matched nothing without an established empty state`,
            evidence: { matchCount: 0 },
          };
        }
        if (snapshot !== undefined) {
          if (snapshot.error !== undefined)
            return { ok: false, type: "extraction-failed", message: snapshot.error };
          return { ok: true, output: { key: step.output, value: snapshot.rows } };
        }
        const rows: Record<string, unknown>[] = [];
        for (let index = 0; index < count; index += 1) {
          const item = items.nth(index);
          const row: Record<string, unknown> = {};
          for (const [key, field] of Object.entries(step.fields)) {
            const target =
              field.locator === undefined || sameLocator(field.locator, step.locator)
                ? item
                : resolveLocator(item, field.locator);
            const matches = await target.count();
            if (matches === 0 && field.optional) continue;
            if (matches !== 1)
              return {
                ok: false,
                type: "extraction-failed",
                message: `Row ${index} field ${key} matched ${matches} elements`,
                evidence: { matchCount: matches },
              };
            const raw =
              field.source === "text"
                ? (await target.innerText({ timeout: timeoutMs })).trim()
                : await target.getAttribute(field.name, { timeout: timeoutMs });
            if (raw === null) {
              if (field.optional) continue;
              return {
                ok: false,
                type: "extraction-failed",
                message: `Row ${index} field ${key} is missing attribute ${field.source === "text" ? "" : field.name}`,
              };
            }
            row[key] =
              field.source === "url"
                ? await target.evaluate((element, name) => {
                    const currentSrc =
                      name === "src" && "currentSrc" in element
                        ? (element as HTMLImageElement).currentSrc
                        : undefined;
                    return (
                      currentSrc ||
                      new URL(element.getAttribute(name)!, element.ownerDocument.baseURI).href
                    );
                  }, field.name)
                : raw;
          }
          rows.push(row);
        }
        return { ok: true, output: { key: step.output, value: rows } };
      }
    }
  } catch (error) {
    if (error instanceof ConditionError)
      return { ok: false, type: error.type, message: error.message };
    if (step.type === "extract-list")
      return { ok: false, type: "extraction-failed", message: String(error) };
    return diagnose(page, step, error);
  }
}

function sameLocator(left: LocatorDefinition, right: LocatorDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface StepSuccess {
  ok: true;
  output?: { key: string; value: unknown };
}

interface StepFailure {
  ok: false;
  actionPerformed?: true;
  type: FailureType;
  message: string;
  evidence?: FailureEvidence;
}

export type StepOutcome = StepSuccess | StepFailure;

async function diagnose(page: Page, step: Step, error: unknown): Promise<StepFailure> {
  const message = error instanceof Error ? error.message : String(error);
  if (/net::|ECONNREFUSED|ENOTFOUND|ERR_/.test(message)) {
    return { ok: false, type: "external-service-error", message };
  }
  if (step.type === "navigate") {
    return { ok: false, type: "navigation-failed", message };
  }
  if (!hasLocator(step)) {
    return { ok: false, type: "unknown", message };
  }

  const locator = resolveLocator(page, step.locator);
  const matchCount = await locator.count().catch(() => undefined);
  if (matchCount === 0) {
    return {
      ok: false,
      type: "locator-not-found",
      message: `${locatorLabel(step.locator)} matched nothing: ${message}`,
      evidence: { matchCount: 0 },
    };
  }
  if (matchCount !== undefined && matchCount > 1) {
    return {
      ok: false,
      type: "locator-ambiguous",
      message: `${locatorLabel(step.locator)} matched ${matchCount}: ${message}`,
      evidence: { matchCount },
    };
  }
  if (matchCount === 1) {
    const visible = await locator.isVisible().catch(() => false);
    const enabled = await locator.isEnabled().catch(() => false);
    if (!visible) {
      return { ok: false, type: "element-not-visible", message, evidence: { matchCount } };
    }
    if (!enabled) {
      return { ok: false, type: "element-disabled", message, evidence: { matchCount } };
    }
  }
  if (/Timeout/i.test(message)) {
    return {
      ok: false,
      type: "timeout",
      message,
      ...(matchCount === undefined ? {} : { evidence: { matchCount } }),
    };
  }
  return { ok: false, type: "unknown", message };
}

async function pageInfo(page: Page): Promise<{ url: string; title?: string }> {
  const title = await page.title().catch(() => undefined);
  return title === undefined || title.length === 0
    ? { url: page.url() }
    : { url: page.url(), title };
}

import { collectPageNavigationEvidence } from "../runtime/page-evidence.js";
import { HostActionError } from "./types.js";
import { addStateImplementation } from "../capabilities/implementations.js";
import { observeCondition } from "../runtime/conditions.js";
import { checkHistoricalCases } from "../evidence/offline.js";
import type { CaseCheck } from "../evidence/types.js";
import { randomUUID } from "node:crypto";
import type { Browser } from "playwright";
import type { RepairAgent } from "../agents/types.js";
import type { SiteActionRegistry } from "../capabilities/lookup.js";
import { applyActionPatches, siteActionAsAutomation } from "../capabilities/repair.js";
import type { SiteActionDefinition } from "../capabilities/types.js";
import { recordSuccessfulSiteActionReuse } from "../capabilities/reuse.js";
import {
  bindLocatorScope,
  classify,
  DEFAULT_REPAIR_CONSTRAINTS,
  hasLocator,
  type Step,
} from "../core/index.js";
import { withIsolatedContext } from "../runtime/browser.js";
import { BrowserResponseCache } from "../runtime/assets.js";
import { configurePageHumanization, isPageHumanized } from "../runtime/humanize.js";
import { isBrowserSession, type BrowserSession } from "../runtime/session.js";
import { bindAutomationDependencies, resolveAutomationActions } from "./dependencies.js";
import { mayValidateStepLive } from "../repair/policy.js";
import {
  DEFAULT_STEP_TIMEOUT_MS,
  HUMANIZED_STEP_TIMEOUT_ALLOWANCE_MS,
} from "../runtime/execute.js";
import { patchCompatibleWithStep } from "../core/repair-result.js";
import { resolveLocator } from "../runtime/locators.js";
import { createPlaywrightHost } from "./host.js";
import { sharedRepairFlights, type RepairFlightCoordinator } from "./repair-flight.js";
import { executeComposedAutomation } from "./sandbox.js";
import type {
  ComposedAutomation,
  AutomationExecutionResult,
  AutomationOutputFile,
  RepairCoordinationMetrics,
} from "./types.js";

export async function runAutomation(
  browser: Browser | BrowserSession,
  automation: ComposedAutomation,
  options: {
    registry: SiteActionRegistry;
    deferVerificationFor?: readonly string[];
    input?: Record<string, unknown>;
    startUrl?: string;
    timeoutMs?: number;
    maxActionCalls?: number;
    stepTimeoutMs?: number;
    haltBefore?: (step: Step) => boolean;
    agent?: RepairAgent;
    repairFlights?: RepairFlightCoordinator;
    beforeSharedRepair?: () => Promise<void>;
    onActionStart?: (event: { name: string; args: unknown }) => void;
    onActionResult?: (event: { name: string; result: unknown }) => void;
    onBrowserActionStart?: () => void;
    capturePageNavigation?: boolean;
    signal?: AbortSignal;
    outputDirectory?: string;
    onFileWrite?: (file: AutomationOutputFile) => void;
    libraryRoot?: string;
    humanize?: boolean;
    loadAutomationSource?: (automationId: string) => Promise<string | undefined>;
  },
): Promise<AutomationExecutionResult> {
  let actions: SiteActionDefinition[];
  try {
    actions = await resolveAutomationActions(options.registry, automation);
  } catch (error) {
    return {
      success: false,
      logs: [],
      actionCalls: [],
      error: error instanceof Error ? error.message : String(error),
      automation,
    };
  }

  try {
    const result = await executeComposedAutomationOnce(browser, automation, actions, options);
    const current = await resolveAutomationActions(options.registry, automation);
    return { ...result, automation: bindAutomationDependencies(automation, current) };
  } catch (error) {
    return {
      success: false,
      logs: [],
      actionCalls: [],
      error: error instanceof Error ? error.message : String(error),
      automation,
    };
  }
}

async function executeComposedAutomationOnce(
  browser: Browser | BrowserSession,
  automation: ComposedAutomation,
  actions: SiteActionDefinition[],
  options: {
    registry: SiteActionRegistry;
    deferVerificationFor?: readonly string[];
    agent?: RepairAgent;
    repairFlights?: RepairFlightCoordinator;
    beforeSharedRepair?: () => Promise<void>;
    input?: Record<string, unknown>;
    startUrl?: string;
    timeoutMs?: number;
    maxActionCalls?: number;
    stepTimeoutMs?: number;
    haltBefore?: (step: Step) => boolean;
    onActionStart?: (event: { name: string; args: unknown }) => void;
    onActionResult?: (event: { name: string; result: unknown }) => void;
    onBrowserActionStart?: () => void;
    capturePageNavigation?: boolean;
    signal?: AbortSignal;
    outputDirectory?: string;
    onFileWrite?: (file: AutomationOutputFile) => void;
    libraryRoot?: string;
    humanize?: boolean;
    loadAutomationSource?: (automationId: string) => Promise<string | undefined>;
  },
): Promise<AutomationExecutionResult> {
  const runId = randomUUID();
  const executeOnPage = async (page: import("playwright").Page) => {
    if (options.humanize !== undefined) await configurePageHumanization(page, options.humanize);
    const sessionResponses = isBrowserSession(browser)
      ? browser.readCapturedResponse?.bind(browser)
      : undefined;
    const localResponses =
      sessionResponses === undefined
        ? new BrowserResponseCache(
            page,
            options.startUrl === undefined
              ? {}
              : { networkOrigin: new URL(options.startUrl).origin },
          )
        : undefined;
    throwIfAborted(options.signal);
    const closePageOnAbort = () =>
      void page.close({ runBeforeUnload: false }).catch(() => undefined);
    options.signal?.addEventListener("abort", closePageOnAbort, { once: true });
    try {
      if (options.startUrl !== undefined) {
        options.onBrowserActionStart?.();
        await page.goto(options.startUrl, { waitUntil: "domcontentloaded" });
        throwIfAborted(options.signal);
      }
      const configuredStepTimeoutMs =
        options.stepTimeoutMs ??
        (isBrowserSession(browser) ? browser.defaultStepTimeoutMs : undefined);
      const stepTimeoutMs =
        options.stepTimeoutMs === undefined && isPageHumanized(page)
          ? (configuredStepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS) +
            HUMANIZED_STEP_TIMEOUT_ALLOWANCE_MS
          : configuredStepTimeoutMs;
      const metrics = emptyCoordination();
      const coverage: CaseCheck[] = [];
      let recovery: AutomationExecutionResult["recovery"];
      let requiresApproval = false;
      const pending = new Map<
        string,
        {
          base: SiteActionDefinition;
          next: SiteActionDefinition;
          owned: boolean;
          advanced: boolean;
        }
      >();
      const base = createPlaywrightHost(page, actions, {
        onEvidenceError: (reason) =>
          coverage.push({
            caseId: runId,
            caseVersion: 1,
            implementationVersion: 0,
            check: "capture",
            status: "inconclusive",
            reason,
          }),
        ...(options.registry.cases ? { cases: options.registry.cases } : {}),
        repair: async (checkpoint) => {
          if (
            !options.agent ||
            (classify(checkpoint.failure).category !== "repairable-browser" &&
              checkpoint.failure.error.type !== "unsupported-state")
          )
            return undefined;
          const failedStep = checkpoint.failure.step;
          metrics.repairAttempts += 1;
          await options.beforeSharedRepair?.();
          const flight = await (options.repairFlights ?? sharedRepairFlights).run(
            {
              siteId: checkpoint.action.siteId,
              actionId: checkpoint.action.id,
              baseVersion: checkpoint.action.version,
            },
            async () => {
              if (!mayValidateStepLive(failedStep))
                return { kind: "refused", actionId: checkpoint.action.id, requiresApproval: true };
              const request = {
                mode: "live-continuation" as const,
                inputs: checkpoint.inputs,
                automation: siteActionAsAutomation({
                  ...checkpoint.action,
                  implementation: checkpoint.implementation,
                }),
                failure: checkpoint.failure,
                constraints: DEFAULT_REPAIR_CONSTRAINTS,
              };
              const proposal = options.agent!.generateLiveRepair
                ? await options.agent!.generateLiveRepair(request, page)
                : await options.agent!.generateRepair(request);
              if (proposal.requiresApproval)
                return { kind: "refused", actionId: checkpoint.action.id, requiresApproval: true };
              if (proposal.success && proposal.statePatch)
                return {
                  kind: "proposed-state",
                  actionId: checkpoint.action.id,
                  patch: proposal.statePatch,
                };
              const patches = proposal.patches ?? proposal.candidate?.changes;
              if (!proposal.success || !patches?.length)
                return {
                  kind: "failed",
                  actionId: checkpoint.action.id,
                  error: proposal.rejected?.reason ?? "No applicable live repair",
                };
              return { kind: "proposed", actionId: checkpoint.action.id, patches };
            },
          );
          if (flight.owned) metrics.repairOwners += 1;
          else {
            metrics.repairWaiters += 1;
            metrics.repairsDeduplicated += 1;
          }
          if (flight.outcome.kind === "refused") {
            requiresApproval = flight.outcome.requiresApproval === true;
            return undefined;
          }
          if (flight.outcome.kind === "proposed-state") {
            if (checkpoint.completedSteps.length) return undefined;
            const next = addStateImplementation(checkpoint.action, flight.outcome.patch);
            const matching = [];
            for (const implementation of next.implementations!)
              if (await observeCondition(page, implementation.precondition!, checkpoint.inputs))
                matching.push(implementation);
            if (matching.length !== 1 || matching[0]!.id !== flight.outcome.patch.implementation.id)
              return undefined;
            const historical = (await options.registry.cases?.list(next.id)) ?? [];
            const offlineBrowser = page.context().browser();
            if (offlineBrowser && historical.length) {
              const checks = await checkHistoricalCases(offlineBrowser, next, historical);
              coverage.push(...checks);
              if (checks.some((check) => check.status === "fail"))
                throw new HostActionError(
                  "Historical cases reject this repair as a regression",
                  checkpoint.failure,
                );
            }
            pending.set(next.id, {
              base: checkpoint.action,
              next,
              owned: flight.owned,
              advanced: false,
            });
            return next;
          }
          if (
            flight.outcome.kind !== "proposed" ||
            checkpoint.failure.error.type === "unsupported-state"
          )
            return undefined;
          if (!hasLocator(failedStep)) return undefined;
          const patches = structuredClone(flight.outcome.patches);
          if (
            patches.some(
              (patch) =>
                patch.type !== "replace-locator" ||
                patch.stepId !== failedStep.id ||
                !patchCompatibleWithStep(failedStep, patch),
            )
          )
            return undefined;
          for (const patch of patches) {
            const scoped = bindLocatorScope(failedStep.locator, patch.locator);
            if ("rejected" in scoped) return undefined;
            patch.locator = {
              ...scoped.locator,
              ...(failedStep.locator.bindings ? { bindings: failedStep.locator.bindings } : {}),
              ...(failedStep.locator.attribute ? { attribute: failedStep.locator.attribute } : {}),
            };
            const target = resolveLocator(page, patch.locator, checkpoint.inputs);
            if (
              (await target.count()) !== 1 ||
              !(await target.isVisible()) ||
              !(await target.isEnabled())
            )
              return undefined;
          }
          const next = applyActionPatches(checkpoint.action, patches, checkpoint.implementation.id);
          const historical = (await options.registry.cases?.list(next.id)) ?? [];
          const offlineBrowser = page.context().browser();
          if (offlineBrowser && historical.length) {
            const checks = await checkHistoricalCases(offlineBrowser, next, historical);
            coverage.push(...checks);
            if (checks.some((check) => check.status === "fail"))
              throw new HostActionError(
                "Historical cases reject this repair as a regression",
                checkpoint.failure,
              );
          }
          const current = await options.registry.get(next.id);
          const advanced = current !== undefined && current.version > checkpoint.action.version;
          pending.set(next.id, {
            advanced,
            base: pending.get(next.id)?.base ?? checkpoint.action,
            next,
            owned: pending.get(next.id)?.owned ?? flight.owned,
          });
          return next;
        },
        onSuccess: async (action, _input, _output, implementation) => {
          const candidate = pending.get(action.id);
          if (!candidate) {
            await recordSuccessfulSiteActionReuse(
              options.registry,
              action.id,
              Date.now(),
              action.version,
              Boolean(implementation.precondition && implementation.completion),
              !options.deferVerificationFor?.includes(action.id),
            );
            return;
          }
          const accepted = await options.registry.updateActionIfVersion({
            siteId: action.siteId,
            actionId: action.id,
            expectedVersion: candidate.base.version,
            next: action,
          });
          if (accepted.updated) metrics.repairsCommitted += 1;
          else if (candidate.owned && candidate.advanced) metrics.staleRepairConflicts += 1;
          if (!candidate.owned) metrics.callersRecoveredFromSharedRepair += 1;
          recovery = {
            kind: "shared-action-repair",
            actionId: action.id,
            fromVersion: candidate.base.version,
            toVersion: action.version,
            repairPerformedByCaller: candidate.owned && !candidate.advanced,
          };
          await recordSuccessfulSiteActionReuse(
            options.registry,
            action.id,
            Date.now(),
            action.version,
            Boolean(implementation.precondition && implementation.completion),
            !options.deferVerificationFor?.includes(action.id),
          );
          pending.delete(action.id);
        },
        runId,
        ...(stepTimeoutMs === undefined ? {} : { timeoutMs: stepTimeoutMs }),
        haltBefore: (step) => {
          if (pending.size && !mayValidateStepLive(step)) {
            requiresApproval = true;
            return true;
          }
          return options.haltBefore?.(step) ?? false;
        },
      });
      const host = {
        async invoke(name: string, args: unknown) {
          throwIfAborted(options.signal);
          options.onActionStart?.({ name, args });
          const result = await base.invoke(name, args);
          options.onActionResult?.({ name, result });
          throwIfAborted(options.signal);
          return result;
        },
      };
      const result = await executeComposedAutomation(automation, {
        host,
        actionNames: actions.map((action) => action.name),
        actions,
        ...(options.input === undefined ? {} : { input: options.input }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxActionCalls === undefined ? {} : { maxActionCalls: options.maxActionCalls }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.outputDirectory === undefined
          ? {}
          : { outputDirectory: options.outputDirectory }),
        ...(options.onFileWrite === undefined ? {} : { onFileWrite: options.onFileWrite }),
        readCapturedResponse: (url, downloadOptions) =>
          sessionResponses === undefined
            ? localResponses!.read(url, downloadOptions)
            : sessionResponses(url, downloadOptions),
        ...(options.libraryRoot === undefined ? {} : { libraryRoot: options.libraryRoot }),
        ...(options.loadAutomationSource === undefined
          ? {}
          : { loadAutomationSource: options.loadAutomationSource }),
      });
      const pageNavigation = options.capturePageNavigation
        ? await collectPageNavigationEvidence(page).catch(() => undefined)
        : undefined;
      return {
        ...result,
        ...(pageNavigation === undefined ? {} : { pageNavigation }),
        ...(coverage.length ? { coverage } : {}),
        ...(metrics.repairAttempts ? { repairCoordination: metrics } : {}),
        ...(requiresApproval ? { requiresApproval: true } : {}),
        ...(recovery
          ? {
              retried: true,
              recovery,
              repairedAction: {
                id: recovery.actionId,
                fromVersion: recovery.fromVersion,
                toVersion: recovery.toVersion,
              },
            }
          : {}),
      };
    } finally {
      options.signal?.removeEventListener("abort", closePageOnAbort);
      localResponses?.close();
    }
  };
  return isBrowserSession(browser)
    ? browser.withPage(executeOnPage)
    : withIsolatedContext(browser, executeOnPage);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : "Prompt cancelled");
  error.name = "AbortError";
  throw error;
}

function emptyCoordination(): RepairCoordinationMetrics {
  return {
    repairAttempts: 0,
    repairOwners: 0,
    repairWaiters: 0,
    repairsCommitted: 0,
    repairsDeduplicated: 0,
    staleRepairConflicts: 0,
    callersRecoveredFromSharedRepair: 0,
  };
}

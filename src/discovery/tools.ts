import type { Browser, Page } from "playwright";
import {
  RunLog,
  hasLocator,
  isStepValue,
  type Automation,
  type FillValue,
  type LocatorDefinition,
  type Step,
  type StepValue,
  type Condition,
} from "../core/index.js";
import { DEFAULT_STEP_TIMEOUT_MS, executeStep } from "../runtime/execute.js";
import { PAGE_SIGNAL_INIT, refineTextTargets } from "../runtime/degraded.js";
import { resolveLocator } from "../runtime/locators.js";
import { collectOverview, type PageOverview } from "../runtime/overview.js";
import { findCandidates, type LocatorCandidate } from "../repair/candidates.js";
import { classifyLocatorProvenance, type LocatorProvenance } from "./provenance.js";
import { addDraftStep, draftSteps, emptyDraft, removeDraftStep, updateDraftStep } from "./draft.js";
import {
  isCoarseExtractLocator,
  validateDraftIntegrity,
  validateDraftLocatorsOnPage,
  type DraftValidationError,
} from "./draft-integrity.js";
import { effectiveGoal, evaluateGoal, goalCheck, type GoalCheck } from "./goal.js";
import type {
  DiscoveryConstraints,
  DiscoveryMetrics,
  DiscoveryOutcome,
  DiscoveryProposal,
  DiscoveryRequest,
} from "./types.js";

export interface ExploreResult {
  ok: boolean;
  actionPerformed?: true;
  url: string;
  error?: string;
  explorationActions: number;
}

export interface LocatorTestResult {
  matches: number;
  visible: boolean;
  enabled: boolean;
  unique: boolean;
}

export interface ReadTextResult {
  matches: number;
  unique: boolean;
  text?: string;
}

export interface DiscoveryTools {
  getOverview(): Promise<PageOverview>;
  getCurrentUrl(): Promise<{ url: string }>;
  testLocator(input: { locator: LocatorDefinition }): Promise<LocatorTestResult>;
  readText(input: { locator: LocatorDefinition }): Promise<ReadTextResult>;
  findCandidates(input?: {
    locator?: LocatorDefinition;
    role?: string;
    name?: string;
    label?: string;
    intent?: "extract" | "act";
  }): Promise<{ candidates: LocatorCandidate[] }>;
  refineTextTarget(input: {
    locator: LocatorDefinition;
  }): Promise<{ candidates: LocatorCandidate[] }>;
  exploreNavigate(input: { url: string }): Promise<ExploreResult>;
  exploreClick(input: {
    locator: LocatorDefinition;
    completion?: Condition;
  }): Promise<ExploreResult>;
  exploreFill(input: { locator: LocatorDefinition; value: string }): Promise<ExploreResult>;
  exploreSelect(input: { locator: LocatorDefinition; value: string }): Promise<ExploreResult>;
  exploreBack(): Promise<ExploreResult>;
  getDraft(): Promise<{ automation: Automation }>;
  addStep(input: { step: Step; beforeStepId?: string }): Promise<{ automation: Automation }>;
  updateStep(input: { step: Step }): Promise<{ automation: Automation }>;
  removeStep(input: { stepId: string }): Promise<{ automation: Automation }>;
  checkGoal(): Promise<GoalCheck>;
  finish(input?: {
    status?: "discovered" | "refused";
    reason?: string;
  }): Promise<DiscoveryProposal | null>;
}

export interface DiscoveryToolContext {
  request: DiscoveryRequest;
  constraints: DiscoveryConstraints;
  log: RunLog;
  draft: Automation;
  explorationActions: number;
  draftMutations: number;
  outcome?: DiscoveryOutcome;
  proposal?: DiscoveryProposal;
  draftErrors?: DraftValidationError[];
  page?: Page;
  timeoutMs: number;
  lastCandidates: LocatorCandidate[];
  locatorProvenance: Array<{ stepId: string; source: LocatorProvenance }>;
}

export function createDiscoveryTools(
  browser: Browser,
  request: DiscoveryRequest,
  options: { runId?: string; timeoutMs?: number; page?: Page } = {},
): { tools: DiscoveryTools; context: DiscoveryToolContext; close: () => Promise<void> } {
  const context: DiscoveryToolContext = {
    ...(options.page ? { page: options.page } : {}),
    request,
    constraints: request.constraints,
    log: new RunLog(options.runId ?? request.id),
    draft: emptyDraft(request),
    explorationActions: 0,
    draftMutations: 0,
    timeoutMs: options.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    lastCandidates: [],
    locatorProvenance: [],
  };
  context.log.emit("discovery.started", {
    task: request.task,
    ...(request.startUrl === undefined ? {} : { startUrl: request.startUrl }),
  });

  let browserContext: import("playwright").BrowserContext | undefined;

  const page = async (): Promise<Page> => {
    if (context.page !== undefined) return context.page;
    browserContext = await browser.newContext();
    await browserContext.addInitScript(PAGE_SIGNAL_INIT);
    context.page = await browserContext.newPage();
    return context.page;
  };

  const tools: DiscoveryTools = {
    async getOverview() {
      return collectOverview(await page());
    },
    async getCurrentUrl() {
      return { url: (await page()).url() };
    },
    async testLocator(input) {
      const locator = resolveLocator(await page(), input.locator);
      const matches = await locator.count();
      const unique = matches === 1;
      return {
        matches,
        unique,
        visible: unique && (await locator.isVisible()),
        enabled: unique && (await locator.isEnabled()),
      };
    },
    async readText(input) {
      const locator = resolveLocator(await page(), input.locator);
      const matches = await locator.count();
      const unique = matches === 1;
      if (!unique) return { matches, unique };
      const text = (await locator.innerText({ timeout: context.timeoutMs })).trim();
      return { matches, unique, text };
    },
    async findCandidates(input) {
      const current = await page();
      const overview = await collectOverview(current);
      const hint = hintStep(input);
      const step = hint ?? fallbackSearchStep();
      const extractHint =
        input?.intent === "extract" || step.type === "extract-text"
          ? (input?.name ?? input?.label)
          : undefined;
      const candidates = await findCandidates(current, step, overview.interactive, {
        includeDegraded: true,
        ...(extractHint === undefined ? {} : { extractHint }),
      });
      context.lastCandidates = candidates;
      return { candidates };
    },
    async refineTextTarget(input) {
      const current = await page();
      const targets = await refineTextTargets(current, input.locator);
      const candidates: LocatorCandidate[] = [];
      for (const target of targets) {
        const matchCount = await resolveLocator(current, target.locator).count();
        candidates.push({
          locator: target.locator,
          source: target.locator.strategy === "css" ? "degraded-dom" : "semantic",
          extractEvidence: target.evidence,
          evidence: {
            roleCompatible: true,
            exactNameMatch: false,
            exactLabelMatch: false,
            nameSimilarity: 0,
            labelSimilarity: 0,
            unique: matchCount === 1,
            sameRole: false,
            sameStrategy: true,
            matchCount,
            visible: true,
            enabled: true,
            structuralContextMatch: false,
            scopeCompatible: true,
          },
        });
      }
      context.lastCandidates = candidates;
      return { candidates };
    },
    async exploreNavigate(input) {
      return explore(context, await page(), {
        id: "explore-navigate",
        type: "navigate",
        safety: "browser-local",
        url: input.url,
      });
    },
    async exploreClick(input) {
      return explore(context, await page(), {
        id: "explore-click",
        type: "click",
        safety: "browser-local",
        locator: input.locator,
        ...(input.completion === undefined ? {} : { completion: input.completion }),
      });
    },
    async exploreFill(input) {
      return explore(context, await page(), {
        id: "explore-fill",
        type: "fill",
        safety: "browser-local",
        locator: input.locator,
        value: input.value,
      });
    },
    async exploreSelect(input) {
      return explore(context, await page(), {
        id: "explore-select",
        type: "select",
        safety: "browser-local",
        locator: input.locator,
        value: input.value,
      });
    },
    async exploreBack() {
      bumpExploration(context);
      const current = await page();
      try {
        await current.goBack({ waitUntil: "domcontentloaded" });
        context.log.emit("exploration.action", { action: "back", url: current.url() });
        return { ok: true, url: current.url(), explorationActions: context.explorationActions };
      } catch (error) {
        return failedExplore(context, current, error);
      }
    },
    async getDraft() {
      return { automation: structuredClone(context.draft) };
    },
    async addStep(input) {
      const step = normalizeStep(input.step, request.inputs);
      rejectDraftStep(step, request);
      await rejectAmbiguousLocator(await page(), step);
      context.draft = addDraftStep(context.draft, step, context.constraints, input.beforeStepId);
      context.draftMutations += 1;
      recordLocatorProvenance(context, step);
      context.log.emit("draft.step.added", { stepId: step.id, stepType: step.type });
      return { automation: structuredClone(context.draft) };
    },
    async updateStep(input) {
      const step = normalizeStep(input.step, request.inputs);
      rejectDraftStep(step, request);
      await rejectAmbiguousLocator(await page(), step);
      context.draft = updateDraftStep(context.draft, step, context.constraints);
      context.draftMutations += 1;
      recordLocatorProvenance(context, step);
      context.log.emit("draft.step.updated", { stepId: step.id, stepType: step.type });
      return { automation: structuredClone(context.draft) };
    },
    async removeStep(input) {
      context.draft = removeDraftStep(context.draft, input.stepId);
      context.draftMutations += 1;
      context.log.emit("draft.step.removed", { stepId: input.stepId });
      return { automation: structuredClone(context.draft) };
    },
    async checkGoal() {
      const goal = effectiveGoal(request.goal);
      if (goal.type === "agent-confirmed") {
        return goalCheck(false, goal, "agent-confirmed requires finishDiscovery");
      }
      return evaluateGoal(await page(), goal);
    },
    async finish(input) {
      if (input?.status === "refused") {
        context.outcome = "correctly-refused";
        context.log.emit("discovery.refused", { reason: input.reason ?? "refused" });
        return null;
      }
      const goal = effectiveGoal(request.goal);
      const check =
        goal.type === "agent-confirmed"
          ? goalCheck(true, goal)
          : await evaluateGoal(await page(), goal);
      if (check.reached) {
        context.log.emit("discovery.goal.reached", { goal: goal.type });
      }
      const automation = {
        ...structuredClone(context.draft),
        verification: {
          status: "unverified" as const,
          discoveryGoalReached: check.reached,
        },
      };
      const integrity = validateDraftIntegrity({
        automation,
        request,
        goalReached: check.reached && check.goalReached,
      });
      const locatorErrors =
        context.page === undefined
          ? []
          : await validateDraftLocatorsOnPage(context.page, automation);
      const errors = [...integrity.errors, ...locatorErrors];
      if (errors.length > 0) {
        context.outcome = "invalid-draft";
        context.draftErrors = errors;
        context.log.emit("discovery.completed", {
          outcome: "invalid-draft",
          stepCount: draftSteps(context.draft).length,
        });
        return null;
      }
      automation.verification.discoveryGoalReached = true;
      const proposal: DiscoveryProposal = {
        automation,
        verification: {
          status: "unverified",
          discoveryGoalReached: true,
        },
        outcome: "discovered",
        metrics: sessionMetrics(context),
      };
      context.draft = automation;
      context.outcome = "discovered";
      context.proposal = proposal;
      context.log.emit("automation.verification.changed", {
        from: undefined,
        to: "unverified",
      });
      context.log.emit("discovery.completed", {
        outcome: "discovered",
        stepCount: draftSteps(automation).length,
      });
      return proposal;
    },
  };

  return {
    tools,
    context,
    close: async () => {
      await browserContext?.close();
    },
  };
}

export function sessionMetrics(
  context: DiscoveryToolContext,
  extras: Partial<DiscoveryMetrics> = {},
): DiscoveryMetrics {
  return {
    modelRequests: extras.modelRequests ?? 0,
    runCodeExecutions: extras.runCodeExecutions ?? 0,
    nestedToolCalls: extras.nestedToolCalls ?? 0,
    explorationActions: context.explorationActions,
    draftMutations: context.draftMutations,
    durationMs: extras.durationMs ?? context.log.events.at(-1)?.t ?? 0,
    finalStepCount: draftSteps(context.draft).length,
    ...(context.locatorProvenance.length === 0
      ? {}
      : { locatorProvenance: context.locatorProvenance }),
    ...(extras.inputTokens === undefined ? {} : { inputTokens: extras.inputTokens }),
    ...(extras.outputTokens === undefined ? {} : { outputTokens: extras.outputTokens }),
  };
}

async function explore(
  context: DiscoveryToolContext,
  page: Page,
  step: Step,
): Promise<ExploreResult> {
  bumpExploration(context);
  const outcome = await executeStep(page, step, context.timeoutMs, context.request.inputs);
  context.log.emit("exploration.action", {
    action: step.type,
    url: page.url(),
    ok: outcome.ok,
  });
  if (!outcome.ok) {
    return {
      ok: false,
      url: page.url(),
      error: outcome.message,
      ...(outcome.actionPerformed ? { actionPerformed: true as const } : {}),
      explorationActions: context.explorationActions,
    };
  }
  return { ok: true, url: page.url(), explorationActions: context.explorationActions };
}

function bumpExploration(context: DiscoveryToolContext): void {
  if (context.explorationActions >= context.constraints.maxExplorationActions) {
    context.outcome = "budget-exhausted";
    throw new Error(
      `maxExplorationActions exceeded (${context.constraints.maxExplorationActions})`,
    );
  }
  context.explorationActions += 1;
}

function failedExplore(context: DiscoveryToolContext, page: Page, error: unknown): ExploreResult {
  return {
    ok: false,
    url: page.url(),
    error: error instanceof Error ? error.message : String(error),
    explorationActions: context.explorationActions,
  };
}

async function rejectAmbiguousLocator(page: Page, step: Step): Promise<void> {
  if (!hasLocator(step)) return;
  const matches = await resolveLocator(page, step.locator).count();
  if (matches > 1) {
    throw new Error(`Locator is ambiguous (${matches} matches)`);
  }
}

function rejectDraftStep(step: Step, request: DiscoveryRequest): void {
  if (step.type === "extract-text" && isCoarseExtractLocator(step.locator)) {
    throw new Error("extract-text locator is a document or root container");
  }
  if ((step.type === "fill" || step.type === "select") && isStepValue(step.value)) {
    if (step.value.kind === "input" && !(step.value.key in (request.inputs ?? {}))) {
      throw new Error(`Input key ${step.value.key} is not in the discovery request`);
    }
  }
}

function normalizeStep(step: Step, inputs: Record<string, unknown> | undefined): Step {
  if (step.type !== "fill" && step.type !== "select") return step;
  return { ...step, value: normalizeValue(step.value, inputs) };
}

function normalizeValue(value: FillValue, inputs: Record<string, unknown> | undefined): StepValue {
  if (isStepValue(value)) return value;
  if (inputs !== undefined) {
    for (const [key, input] of Object.entries(inputs)) {
      if (String(input) === value) return { kind: "input", key };
    }
  }
  return { kind: "literal", value };
}

function hintStep(
  input:
    | {
        locator?: LocatorDefinition;
        role?: string;
        name?: string;
        label?: string;
        intent?: "extract" | "act";
      }
    | undefined,
): Step | undefined {
  if (input?.locator !== undefined) {
    return {
      id: "hint",
      type: "click",
      safety: "browser-local",
      locator: input.locator,
    };
  }
  if (input?.label !== undefined) {
    return {
      id: "hint",
      type: "fill",
      safety: "browser-local",
      locator: { strategy: "label", label: input.label },
      value: "",
    };
  }
  if (input?.role !== undefined) {
    return {
      id: "hint",
      type: "click",
      safety: "browser-local",
      locator: {
        strategy: "role",
        role: input.role,
        ...(input.name === undefined ? {} : { name: input.name }),
      },
    };
  }
  if (input?.name !== undefined) {
    return {
      id: "hint",
      type: "extract-text",
      safety: "read-only",
      locator: { strategy: "text", text: input.name, exact: true },
      output: "hint",
    };
  }
  if (input?.intent === "extract") {
    return {
      id: "hint",
      type: "extract-text",
      safety: "read-only",
      locator: { strategy: "text", text: input.label ?? "" },
      output: "hint",
    };
  }
  return undefined;
}

function recordLocatorProvenance(context: DiscoveryToolContext, step: Step): void {
  if (!hasLocator(step)) return;
  const source = classifyLocatorProvenance(step.locator, context.lastCandidates);
  context.locatorProvenance = [
    ...context.locatorProvenance.filter((item) => item.stepId !== step.id),
    { stepId: step.id, source },
  ];
}

function fallbackSearchStep(): Step {
  return {
    id: "hint",
    type: "click",
    safety: "browser-local",
    locator: { strategy: "role", role: "button" },
  };
}

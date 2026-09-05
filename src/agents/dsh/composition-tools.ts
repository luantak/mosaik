import { readDiscoveryEvidence } from "./discovery-evidence.js";
import { toSummary } from "../../capabilities/lookup.js";
import type { SiteActionDefinition, SiteActionSummary } from "../../capabilities/types.js";
import { assertSiteCapability } from "../../capabilities/granularity.js";
import { readFile } from "node:fs/promises";
import { EvidenceStore } from "../evidence.js";
import { presentObservation, withoutObservationLocators } from "./observation-presentation.js";
import type { Browser } from "playwright";
import { createNavigationObserver } from "./navigation-observation.js";
import { Context } from "@deepseek-ai/cordis";
import { WorkerThreadCodeRuntime } from "@deepseek-ai/dsh-code-runtime-worker-thread";
import { CallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool, RUN_CODE_NAME } from "@deepseek-ai/dsh-tools";
import type { CapabilityNeed } from "../../capabilities/compose.js";
import { normalizeCapabilityNeed, validateWorkflowNeeds } from "../../capabilities/plan.js";
import type { CompositionSession } from "../../capabilities/code-mode.js";
import type { ComposedAutomation } from "../../automations/types.js";
import { suppressExperimentalTypeStripWarning } from "../../automations/typescript.js";
import { createCompositionSession } from "../../capabilities/code-mode.js";
import { openFileRepository } from "../../persist/index.js";
import type { ReusableActionDiscoveryRequest } from "../types.js";
import { DshReusableActionDiscoveryAgent } from "./action-agent.js";
import type { DshReasoning } from "./session.js";

import { parseTaskOutcome } from "../outcome.js";

suppressExperimentalTypeStripWarning();

export const name = "dsh-composition-semantic-tools";
export const inject = ["tools"];

interface SerializedCompositionInput {
  storeRoot: string;
  projectRoot: string;
  libraryRoot?: string;
  model: string;
  task: string;
  siteId: string;
  startUrl: string;
  observedUrls?: string[];
  inputs: Record<string, unknown>;
  safety: ReusableActionDiscoveryRequest["safety"];
  budgets: ReusableActionDiscoveryRequest["budgets"];
  discoveryReasoning: DshReasoning;
  runRoot?: string;
}

export async function apply(ctx: Context): Promise<void> {
  if (process.env.MOSAIK_OUTCOME_REVIEW === "1") {
    const evidence = new EvidenceStore(
      process.env.MOSAIK_EVIDENCE_PATH
        ? JSON.parse(await readFile(process.env.MOSAIK_EVIDENCE_PATH, "utf8"))
        : {},
    );
    ctx.tools.register(
      defineTool({
        name: "readEvidence",
        description:
          "Read full execution evidence by evidenceId in pages of up to 16000 characters. Follow nextOffset when more relevant content is needed.",
        parameters: {
          evidenceId: { type: "string", required: true },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
        isConcurrencySafe: () => true,
        execute: async (args) => asJson(evidence.read(args.evidenceId, args.offset, args.limit)),
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "finishOutcome",
        description:
          "Report whether evidence fulfills the original request and deliver an answer or explain missing evidence.",
        parameters: {
          status: { type: "string", enum: ["complete", "incomplete"], required: true },
          answer: { type: "string" },
          reason: { type: "string" },
        },
        output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
        execute: async (args) => {
          const outcome = parseTaskOutcome(args);
          if (outcome === undefined)
            throw new Error(
              "A complete outcome requires an answer; an incomplete outcome requires a reason.",
            );
          return asJson(outcome);
        },
      }),
    );
    return;
  }
  const serialized = process.env.MOSAIK_COMPOSITION_INPUT;
  if (serialized === undefined) throw new Error("MOSAIK_COMPOSITION_INPUT is required");
  const request = JSON.parse(serialized) as SerializedCompositionInput;
  const store = openFileRepository({
    dataRoot: request.storeRoot,
    libraryRoot: request.libraryRoot ?? request.projectRoot,
  });
  const discovery = new DshReusableActionDiscoveryAgent(
    request.storeRoot,
    request.projectRoot,
    request.model,
    request.discoveryReasoning,
    request.runRoot,
  );
  const session = createCompositionSession({
    task: request.task,
    suppliedInputs: request.inputs,
    registry: store.siteActions,
    saveAutomation: (automation) => store.saveAutomation(automation),
    discover: async (need, prerequisiteActions) => {
      const result = await discovery.discoverReusableAction({
        task: request.task,
        capabilityIntent: [
          need.intent ?? need.description ?? need.name ?? "missing capability",
          ...(need.context === undefined ? [] : [`Required context: ${need.context}`]),
        ].join(". "),
        ...(need.name === undefined ? {} : { capabilityName: need.name }),
        siteId: request.siteId,
        startUrl: request.startUrl,
        inputs: request.inputs,
        allowRepresentativeItem: need.cardinality === "per-item",
        ...(prerequisiteActions === undefined ? {} : { prerequisiteActions }),
        safety: request.safety,
        budgets: request.budgets,
      });
      if (result.status !== "discovered") throw new Error(result.reason);
      return {
        action: result.action,
        metrics: result.metrics,
        ...(result.observedPage === undefined ? {} : { observedPage: result.observedPage }),
      };
    },
  });
  await session.list(request.siteId);
  await registerCompositionTools(ctx, session, {
    discoverBatch: async (stages) => {
      const requests = stages.map(({ need, prerequisites }) => ({
        task: request.task,
        capabilityIntent: [
          need.intent ?? need.description ?? need.name ?? "missing capability",
          ...(need.context ? [`Required context: ${need.context}`] : []),
        ].join(". "),
        ...(need.name ? { capabilityName: need.name } : {}),
        siteId: request.siteId,
        startUrl: request.startUrl,
        inputs: request.inputs,
        allowRepresentativeItem: need.cardinality === "per-item",
        prerequisiteActions: prerequisites,
        safety: request.safety,
        budgets: request.budgets,
      }));
      const result = await discovery.discoverReusableAction(requests[0]!, requests.slice(1));
      if (result.status !== "discovered") throw new Error(result.reason);
      const actions = result.actions ?? [result.action];
      const observedInputs: Record<string, Record<string, unknown>> = {};
      if (request.runRoot) {
        const evidence = await readDiscoveryEvidence(request.runRoot);
        for (const observation of evidence.discoveryObservations ?? []) {
          if (!observation || typeof observation !== "object") continue;
          const item = observation as { name?: string; inputs?: Record<string, unknown> };
          const action = actions.find((action) => action.name === item.name);
          if (action && item.inputs)
            observedInputs[action.name] = Object.fromEntries(
              Object.keys(action.inputs)
                .filter((key) => key in item.inputs!)
                .map((key) => [key, item.inputs![key]]),
            );
        }
      }
      return { metrics: result.metrics, actions, observedInputs };
    },
    compact: true,
    ...(request.safety.allowedActionSafety.includes("read-only")
      ? { startUrl: request.startUrl, observedUrls: request.observedUrls ?? [] }
      : {}),
  });
}

const renderJson = (_args: unknown, value: unknown) => [
  { type: "text" as const, text: JSON.stringify(value) },
];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function asJson(value: unknown): { [key: string]: Json } {
  return JSON.parse(JSON.stringify(value)) as { [key: string]: Json };
}

const needParameter = {
  type: "object",
  additionalProperties: false,
  properties: {
    stage: {
      type: "string",
      description: "Stable workflow stage id. Required for every stage when any stage is used.",
    },
    name: { type: "string" },
    intent: { type: "string" },
    description: { type: "string" },
    context: {
      type: "string",
      description:
        "Required page or workflow context when the user constrains where this capability runs.",
    },
    after: {
      type: "array",
      items: { type: "string" },
      description: "Stage ids that must complete before this stage.",
    },
    cardinality: {
      type: "string",
      enum: ["once", "per-item"],
      description: "Whether this capability runs once or for each collected item.",
    },
  },
} as const;

export async function registerCompositionTools(
  ctx: Context,
  session: CompositionSession,
  options: {
    compact?: boolean;
    startUrl?: string;
    browser?: Browser;
    observedUrls?: string[];
    discoverBatch?: (needs: Array<{ need: CapabilityNeed; prerequisites: string[] }>) => Promise<{
      metrics: unknown;
      actions: Array<SiteActionDefinition | SiteActionSummary>;
      observedInputs?: Record<string, Record<string, unknown>>;
    }>;
  } = {},
): Promise<void> {
  if (options.startUrl !== undefined) {
    const evidence = new EvidenceStore();
    const observer = createNavigationObserver({
      startUrl: options.startUrl,
      observedUrls: options.observedUrls ?? [],
      ...(options.browser ? { browser: options.browser } : {}),
    });
    ctx.effect(() => () => observer.close(), "mosaik:planning-observation-browser");
    ctx.tools.register(
      defineTool({
        name: "readEvidence",
        description:
          "Read omitted planning observation entries by evidenceId. Samples do not establish that an item is absent. Follow nextOffset for more entries.",
        parameters: {
          evidenceId: { type: "string", required: true },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
        isConcurrencySafe: () => true,
        execute: async (args) => asJson(evidence.read(args.evidenceId, args.offset, args.limit)),
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "inspectNavigation",
        description:
          "Observe navigation for planning without discovering, saving, or requiring a reusable action. Omit url to inspect startUrl; subsequent URLs must be links returned by this tool or structured browser evidence supplied for recovery. Returns page identity, headings, landmarks and absolute links. Large arrays are samples with Summary evidenceIds; readEvidence retrieves omitted entries. Inspection navigates the same invocation tab used by discovery and execution. Plan the complete reusable route from startUrl before prepareComposition, including necessary intermediate navigation. Inspection itself does not save those steps. Do not use observations instead of runtime collection for changing results, per-item tasks, or user-required steps.",
        parameters: { url: { type: "string" } },
        timeoutMs: 30_000,
        output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
        execute: async (args) =>
          asJson(
            presentObservation(
              withoutObservationLocators(await observer.inspect(args.url)),
              evidence,
            ),
          ),
      }),
    );
  }
  let preparedWorkflow: string | undefined;
  let preparedNeeds: CapabilityNeed[] | undefined;
  ctx.tools.register(
    defineTool({
      name: "prepareComposition",
      description:
        "Inspect the site library, reuse compatible actions, and discover missing semantic site actions. Navigation to the exact startUrl is removed because the runtime already opens the current turn's page. Do not include runtimeHandled stages in the automation or discovery prerequisites. The same run_code automation may use this result to construct TypeScript and call finishComposition.",
      parameters: {
        siteId: { type: "string", required: true },
        task: { type: "string", required: true },
        needs: { type: "array", required: true, items: needParameter },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const proposed = args.needs as CapabilityNeed[];
        if (options.compact === true) assertStagedWorkflow(proposed);
        assertRequestedWorkflow(args.task, proposed);
        const { needs, runtimeHandled } = projectSemanticWorkflow(proposed, options.startUrl);
        if (needs.length === 0) {
          throw new Error("At least one semantic site capability is required");
        }
        const plan = await session.plan({ siteId: args.siteId, task: args.task, needs });
        if (plan.matches.some((match) => match.ambiguous === true)) {
          throw new Error("Capability search is ambiguous; refine the need before composition");
        }
        let batchMetrics: unknown;
        let observedInputs: Record<string, Record<string, unknown>> = {};
        const batchActions = new Map<string, SiteActionSummary>();
        if (options.discoverBatch && plan.matches.some((match) => !match.name)) {
          const prefixes = new Map<string, string[]>();
          const names = new Map<string, string>();
          const sequential: string[] = [];
          const missing = [];
          for (const match of plan.matches) {
            const prerequisites =
              match.need.stage === undefined
                ? [...sequential]
                : [
                    ...new Set(
                      (match.need.after ?? []).flatMap((stage) => [
                        ...(prefixes.get(stage) ?? []),
                        ...(names.has(stage) ? [names.get(stage)!] : []),
                      ]),
                    ),
                  ];
            const name = match.name ?? match.need.name;
            if (!name)
              throw new Error(
                "Give each missing capability a reusable name before grouped discovery",
              );
            if (!match.name) {
              assertSiteCapability({
                name,
                description: match.need.description ?? match.need.intent ?? name,
              });
              missing.push({ need: match.need, prerequisites });
            }
            sequential.push(name);
            if (match.need.stage) {
              prefixes.set(match.need.stage, prerequisites);
              names.set(match.need.stage, name);
            }
          }
          const batch = await options.discoverBatch(missing);
          batchMetrics = batch.metrics;
          observedInputs = batch.observedInputs ?? {};
          for (const [index, action] of batch.actions.entries()) {
            const need = missing[index]?.need;
            if (need === undefined) throw new Error(`Unexpected discovered action ${action.name}`);
            batchActions.set(action.name, "implementation" in action ? toSummary(action) : action);
          }
        }
        const discovered = [];
        const prerequisiteActions: string[] = [];
        const stageActions = new Map<string, string>();
        const stagePrefixes = new Map<string, string[]>();
        for (const match of plan.matches) {
          const prerequisites =
            match.need.stage === undefined
              ? [...prerequisiteActions]
              : [
                  ...new Set(
                    (match.need.after ?? []).flatMap((stage) => [
                      ...(stagePrefixes.get(stage) ?? []),
                      ...(stageActions.has(stage) ? [stageActions.get(stage)!] : []),
                    ]),
                  ),
                ];
          if (match.need.stage !== undefined) stagePrefixes.set(match.need.stage, prerequisites);
          if (match.name !== undefined) {
            if (!prerequisiteActions.includes(match.name)) prerequisiteActions.push(match.name);
            if (match.need.stage !== undefined) stageActions.set(match.need.stage, match.name);
            continue;
          }
          const action =
            batchActions.get(match.need.name ?? "") ??
            (await session.discover({ ...match.need, siteId: args.siteId }, prerequisites));
          discovered.push({
            ...action,
            ...(batchMetrics === undefined ? {} : { discoveryMetrics: batchMetrics }),
          });
          batchMetrics = undefined;
          prerequisiteActions.push(action.name);
          if (match.need.stage !== undefined) stageActions.set(match.need.stage, action.name);
        }
        preparedWorkflow = workflowFingerprint(proposed);
        preparedNeeds = structuredClone(proposed);
        return asJson({
          plan,
          discovered,
          runtimeHandled,
          preparedNeeds: proposed,
          observedInputs,
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "finishComposition",
      description:
        "Compose, validate, persist, and return the terminal { status: composed, automation, reused, discovered } result for model-generated Mosaik TypeScript. After prepareComposition succeeds, omit needs to use the exact saved workflow. Supply needs only for full reuse without preparation or to repeat that same workflow.",
      parameters: {
        siteId: { type: "string", required: true },
        task: { type: "string", required: true },
        needs: { type: "array", items: needParameter },
        automationId: { type: "string" },
        automationSource: { type: "string", required: true },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const proposed = (args.needs as CapabilityNeed[] | undefined) ?? preparedNeeds;
        if (proposed === undefined)
          throw new Error("Supply needs for full reuse or call prepareComposition first");
        if (options.compact === true) assertStagedWorkflow(proposed);
        assertRequestedWorkflow(args.task, proposed);
        if (preparedWorkflow !== undefined && workflowFingerprint(proposed) !== preparedWorkflow) {
          throw new Error(
            "finishComposition must use the exact workflow stages previously prepared",
          );
        }
        const { needs, runtimeHandled } = projectSemanticWorkflow(proposed, options.startUrl);
        assertRuntimeHandledNotReplayed(runtimeHandled, args.automationSource);
        assertTaskLogic(args.task, args.automationSource);
        const composed = await session.compose({
          siteId: args.siteId,
          task: args.task,
          needs,
          ...(args.automationId === undefined ? {} : { automationId: args.automationId }),
          automationSource: args.automationSource,
        });
        assertWorkflowAutomation(needs, composed.resolved, args.automationSource);
        const saved = await session.saveAutomation(composed.automation);
        return asJson({
          ...saved,
          reused: composed.reused,
          discovered: composed.discovered,
          rediscovered: composed.rediscovered,
        });
      },
    }),
  );

  if (options.compact === true) return;

  ctx.tools.register(
    defineTool({
      name: "listCapabilities",
      description:
        "List known site actions as summaries. Inspect the library before composing or discovering.",
      parameters: { siteId: { type: "string", required: true } },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) => asJson({ actions: await session.list(args.siteId) }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "searchCapabilities",
      description: "Search known site actions by intent, description, aliases, or schema keys.",
      parameters: {
        siteId: { type: "string", required: true },
        intent: { type: "string", required: true },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) => asJson({ actions: await session.search(args.siteId, args.intent) }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "getCapability",
      description: "Return one site action summary without its implementation.",
      parameters: { actionId: { type: "string", required: true } },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) => asJson({ action: (await session.get(args.actionId)) ?? null }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "planTask",
      description: "Inspect the site library and match needs to known actions or missing intents.",
      parameters: {
        siteId: { type: "string", required: true },
        task: { type: "string", required: true },
        needs: { type: "array", required: true, items: needParameter },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) =>
        asJson(
          await session.plan({
            siteId: args.siteId,
            task: args.task,
            needs: args.needs as CapabilityNeed[],
          }),
        ),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "discoverAction",
      description:
        "Discover one missing site capability after inspect. Do not learn task-specific workflows.",
      parameters: {
        siteId: { type: "string", required: true },
        intent: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const need: CapabilityNeed & { siteId: string } = { siteId: args.siteId };
        if (args.name !== undefined) need.name = args.name;
        if (args.intent !== undefined) need.intent = args.intent;
        if (args.description !== undefined) need.description = args.description;
        return asJson({ action: await session.discover(need) });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "composeTask",
      description:
        "Compose a Mosaik TypeScript automation. automationSource must be `export default defineAutomation(import.meta.url, async (ctx, input: { ... }) => { ... })` with an explicit input type and use input fields for caller values.",
      parameters: {
        siteId: { type: "string", required: true },
        task: { type: "string", required: true },
        needs: { type: "array", required: true, items: needParameter },
        automationId: { type: "string" },
        automationSource: { type: "string" },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) =>
        asJson(
          await session.compose({
            siteId: args.siteId,
            task: args.task,
            needs: args.needs as CapabilityNeed[],
            ...(args.automationId === undefined ? {} : { automationId: args.automationId }),
            ...(args.automationSource === undefined
              ? {}
              : { automationSource: args.automationSource }),
          }),
        ),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "saveAutomation",
      description:
        "Persist generated Mosaik TypeScript and return the terminal { status: composed, automation } result. Return this result from run_code. Do not persist Code Mode, run_code, or tool scripts.",
      parameters: {
        automation: {
          type: "object",
          required: true,
          additionalProperties: true,
          properties: {
            id: { type: "string", required: true },
            siteId: { type: "string", required: true },
            source: { type: "string", required: true },
            version: { type: "number" },
            actionIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) =>
        asJson(await session.saveAutomation(args.automation as ComposedAutomation)),
    }),
  );
}

function isRuntimeNavigationNeed(need: CapabilityNeed, startUrl?: string): boolean {
  if (need.cardinality === "per-item" || (need.after?.length ?? 0) > 0) return false;
  const raw = [need.name, need.intent, need.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const text = raw.toLowerCase();
  const genericStartNavigation =
    /\b(?:start(?:ing)?|initial|provided|supplied)\s+(?:url|page)\b/.test(text) &&
    /\b(?:go|load|navigate|open)\b/.test(text);
  if (genericStartNavigation) return true;
  if (startUrl === undefined || !/\b(?:go|load|navigate|open)\b/.test(text)) return false;
  return urlsIn(raw).some((candidate) => sameRuntimeUrl(candidate, startUrl));
}

function isRuntimeHandledNeed(need: CapabilityNeed, startUrl?: string): boolean {
  if (isRuntimeNavigationNeed(need, startUrl)) return true;
  const intent = `${need.intent ?? ""} ${need.description ?? ""}`.toLowerCase();
  return (
    /\bdownload\b/.test(intent) &&
    /\b(?:absolute|extracted)\s+url\b/.test(intent) &&
    !/\b(?:click|button|control|form|generate)\b/.test(intent)
  );
}

export function projectSemanticWorkflow(
  needs: CapabilityNeed[],
  startUrl?: string,
): {
  needs: CapabilityNeed[];
  runtimeHandled: CapabilityNeed[];
} {
  validateWorkflowNeeds(needs);
  const runtimeHandled = needs.filter((need) => isRuntimeHandledNeed(need, startUrl));
  const removed = new Map(
    runtimeHandled
      .filter((need): need is CapabilityNeed & { stage: string } => need.stage !== undefined)
      .map((need) => [need.stage, need]),
  );
  const expand = (dependencies: string[], seen = new Set<string>()): string[] => {
    const expanded: string[] = [];
    for (const dependency of dependencies) {
      if (seen.has(dependency)) throw new Error(`Workflow dependency cycle at ${dependency}`);
      const runtime = removed.get(dependency);
      if (runtime === undefined) {
        expanded.push(dependency);
        continue;
      }
      expanded.push(...expand(runtime.after ?? [], new Set([...seen, dependency])));
    }
    return [...new Set(expanded)];
  };
  const semantic = needs
    .filter((need) => !isRuntimeHandledNeed(need, startUrl))
    .map((need) => ({
      ...need,
      ...(need.after === undefined ? {} : { after: expand(need.after) }),
    }));
  validateWorkflowNeeds(semantic);
  return { needs: semantic, runtimeHandled };
}

function urlsIn(value: string): string[] {
  return [...value.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) =>
    match[0].replace(/[),.;]+$/, ""),
  );
}

function sameRuntimeUrl(left: string, right: string): boolean {
  try {
    const normalize = (value: string) => {
      const url = new URL(value);
      url.hash = "";
      url.pathname = url.pathname.replace(/\/+$/, "") || "/";
      return url.href;
    };
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

function assertRuntimeHandledNotReplayed(needs: CapabilityNeed[], source: string): void {
  for (const need of needs) {
    if (need.name === undefined) continue;
    const name = normalizeCapabilityNeed({ name: need.name }).name;
    if (name !== undefined && findActionCalls(source, name).length > 0) {
      throw new Error(
        `Workflow stage ${need.stage ?? name} is already satisfied by startUrl; omit action ${name} from the automation`,
      );
    }
  }
}

function workflowFingerprint(needs: CapabilityNeed[]): string {
  return JSON.stringify(needs.map(normalizeWorkflowNeed));
}

function normalizeWorkflowNeed(need: CapabilityNeed): CapabilityNeed {
  const name =
    need.name === undefined ? undefined : normalizeCapabilityNeed({ name: need.name.trim() }).name;
  return {
    ...(need.stage === undefined ? {} : { stage: need.stage.trim() }),
    ...(name === undefined ? {} : { name }),
    ...(need.intent === undefined ? {} : { intent: need.intent.trim() }),
    ...(need.description === undefined ? {} : { description: need.description.trim() }),
    ...(need.context === undefined ? {} : { context: need.context.trim() }),
    ...(need.after === undefined ? {} : { after: [...need.after] }),
    ...(need.cardinality === undefined ? {} : { cardinality: need.cardinality }),
  };
}

function assertStagedWorkflow(needs: CapabilityNeed[]): void {
  if (needs.length === 0) throw new Error("A workflow requires at least one capability stage");
  for (const need of needs) {
    if (need.stage === undefined || need.cardinality === undefined) {
      throw new Error(
        "Every capability need must declare a workflow stage and cardinality before action reuse",
      );
    }
  }
}

function assertRequestedWorkflow(task: string, needs: CapabilityNeed[]): void {
  const normalized = task.toLowerCase();
  const requiresItemPage =
    /\b(?:detail|individual|item|product|article|record|book)\s+pages?\b/.test(normalized) ||
    (/\bpages?\b/.test(normalized) &&
      /\bnot\s+(?:the\s+)?(?:overview|listing|index|feed|search results?)\b/.test(normalized));
  if (!requiresItemPage) return;

  const perItemOpen = needs.find(
    (need) =>
      need.cardinality === "per-item" && /\b(?:open|visit|navigate|load)\b/.test(needText(need)),
  );
  const perItemRead = needs.find(
    (need) =>
      need.cardinality === "per-item" &&
      /\b(?:extract|read|collect|get|download)\b/.test(needText(need)) &&
      (perItemOpen?.stage === undefined || (need.after ?? []).includes(perItemOpen.stage)),
  );
  if (perItemOpen === undefined || perItemRead === undefined) {
    throw new Error(
      "The task requires item pages: add a per-item open stage and a dependent per-item extraction stage",
    );
  }
}

function needText(need: CapabilityNeed): string {
  return [need.name, need.intent, need.description, need.context]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();
}

function assertTaskLogic(task: string, source: string): void {
  const normalized = task.toLowerCase();
  if (/\bdownload\b/.test(normalized) && !/\bctx\.files\.download\s*\(/.test(source)) {
    throw new Error("Download tasks must save files with ctx.files.download");
  }
  if (/\b(?:every|each|all)\b/.test(normalized) && !/\b(?:for|while)\s*\(/.test(source)) {
    throw new Error("Tasks over every matching item require a TypeScript loop");
  }
  if (/\b(?:under|below|less than)\b/.test(normalized)) {
    const filters = /\.filter\s*\(/.test(source);
    const comparesInput =
      /(?:<|<=)\s*input\.[A-Za-z_$][\w$]*/.test(source) ||
      /input\.[A-Za-z_$][\w$]*\s*(?:>|>=)/.test(source);
    if (!filters || !comparesInput) {
      throw new Error(
        "Thresholds must be applied with a TypeScript filter and an input comparison; do not append them to the search query",
      );
    }
  }
}

function assertWorkflowAutomation(
  needs: CapabilityNeed[],
  resolved: Array<{ need: CapabilityNeed; action: string }>,
  source: string,
): void {
  if (!needs.some((need) => need.stage !== undefined)) return;
  const loopRanges = findLoopRanges(source);
  const occurrenceByAction = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const stage of resolved) {
    const id = stage.need.stage;
    if (id === undefined) continue;
    const calls = findActionCalls(source, stage.action);
    const occurrence = occurrenceByAction.get(stage.action) ?? 0;
    const position = calls[occurrence];
    if (position === undefined) {
      throw new Error(`Workflow stage ${id} must call action ${stage.action}`);
    }
    occurrenceByAction.set(stage.action, occurrence + 1);
    if (
      stage.need.cardinality === "per-item" &&
      !loopRanges.some(([start, end]) => position > start && position < end)
    ) {
      throw new Error(`Workflow stage ${id} must run inside an item loop`);
    }
    positions.set(id, position);
  }
  for (const stage of needs) {
    if (stage.stage === undefined) continue;
    const position = positions.get(stage.stage);
    if (position === undefined) continue;
    for (const dependency of stage.after ?? []) {
      const dependencyPosition = positions.get(dependency);
      if (dependencyPosition !== undefined && dependencyPosition >= position) {
        throw new Error(`Workflow stage ${stage.stage} must run after ${dependency}`);
      }
    }
  }
}

function findActionCalls(source: string, action: string): number[] {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:\\bctx\\.actions\\.)?\\b${escaped}\\s*\\(`, "g");
  return [...source.matchAll(pattern)].map((match) => match.index);
}

function findLoopRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const pattern = /\b(?:for|while)\s*\([^)]*\)\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf("{");
    const close = matchingBrace(source, open);
    if (close !== undefined) ranges.push([open, close]);
  }
  return ranges;
}

function matchingBrace(source: string, open: number): number | undefined {
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return index;
  }
  return undefined;
}

export async function runCompositionCode(
  session: CompositionSession,
  code: string,
  options: Parameters<typeof registerCompositionTools>[2] = {},
): Promise<{ value: unknown; runCodeExecutions: number; nestedToolCalls: number }> {
  const harness = new Context();
  let nestedToolCalls = 0;
  try {
    await harness.plugin(SystemPrompt);
    await harness.plugin(ToolRuntime, { mode: "code", maxParallelSubCalls: 1 });
    await harness.plugin(WorkerThreadCodeRuntime, {});
    await registerCompositionTools(harness, session, options);
    harness.on("tools/result", (execution) => {
      if (execution.name !== RUN_CODE_NAME) nestedToolCalls += 1;
    });
    const result = await harness.tools.execute({
      callId: CallId("composition-code-1"),
      name: RUN_CODE_NAME,
      arguments: {
        code,
        description:
          "Compose a Mosaik automation from site capabilities in one Code Mode automation",
      },
      signal: new AbortController().signal,
    });
    if (result.isError) {
      throw new Error(
        result.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
      );
    }
    return { value: result.value, runCodeExecutions: 1, nestedToolCalls };
  } finally {
    await harness.fiber.dispose();
  }
}

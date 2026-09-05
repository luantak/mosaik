import { isDeepStrictEqual } from "node:util";
import { discoveryOperation } from "./discovery-operations.js";
import { ElementReferences } from "./element-references.js";
import { collectPageNavigationEvidence } from "../../runtime/page-evidence.js";
import { OverviewHistory } from "./overview-history.js";
import { presentObservation } from "./observation-presentation.js";
import { randomUUID } from "node:crypto";
import { EvidenceStore } from "../evidence.js";
import { locatorAlternatives } from "../../runtime/locator-alternatives.js";
import { Context } from "@deepseek-ai/cordis";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkerThreadCodeRuntime } from "@deepseek-ai/dsh-code-runtime-worker-thread";
import { CallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool, RUN_CODE_NAME } from "@deepseek-ai/dsh-tools";
import type { Browser, ElementHandle } from "playwright";
import type { ActionDiscoverySession } from "../../capabilities/action-discovery.js";
import { coerceValue } from "../../capabilities/schema.js";
import type { ActionSchema, ActionType, SiteActionDefinition } from "../../capabilities/types.js";
import type {
  FillValue,
  ListField,
  LocatorDefinition,
  Step,
  StepSafety,
} from "../../core/index.js";
import { createDiscoveryTools } from "../../discovery/index.js";
import { DEFAULT_DISCOVERY_CONSTRAINTS } from "../../discovery/types.js";
import { openFileRepository } from "../../persist/index.js";
import { bindLocator, resolveLocator } from "../../runtime/locators.js";
import { resolveStepValue, type Condition } from "../../core/types.js";
import { inputReferences, validateCondition } from "../../capabilities/contracts.js";
import { textContentTarget } from "../../runtime/text-preview.js";
import { executeStep } from "../../runtime/execute.js";
import { captureBefore, observeCondition, type BeforeValues } from "../../runtime/conditions.js";
import { openAgentBrowser, sharedAgentPage } from "../../runtime/session.js";
import { createPlaywrightHost } from "../../automations/host.js";
import { suppressExperimentalTypeStripWarning } from "../../automations/typescript.js";
import { createActionDiscoverySession } from "../../capabilities/action-discovery.js";
import { createMemoryRegistry, type SiteActionRegistry } from "../../capabilities/lookup.js";
import { recordSuccessfulSiteActionReuse } from "../../capabilities/reuse.js";
import { toPageSnapshot } from "../../runtime/overview.js";

suppressExperimentalTypeStripWarning();

export const name = "dsh-action-discovery-semantic-tools";
export const inject = ["tools", "systemPrompt"];

interface SerializedActionDiscoveryInput {
  storeRoot: string;
  libraryRoot?: string;
  projectRoot?: string;
  siteId: string;
  startUrl: string;
  task: string;
  allowedSafety: StepSafety[];
  inputs: Record<string, unknown>;
  prerequisiteActions: string[];
  allowRepresentativeItem?: boolean;
  expectedActionName?: string;
  related?: SerializedActionDiscoveryInput[];
}

export async function apply(ctx: Context): Promise<void> {
  const serialized = process.env.MOSAIK_ACTION_DISCOVERY_INPUT;
  if (serialized === undefined) throw new Error("MOSAIK_ACTION_DISCOVERY_INPUT is required");
  const input = JSON.parse(serialized) as SerializedActionDiscoveryInput;
  const store = openFileRepository({
    dataRoot: input.storeRoot,
    libraryRoot: input.libraryRoot ?? input.projectRoot ?? input.storeRoot,
  });
  const existingActions = await store.siteActions.list(input.siteId);
  const stagedActions = createMemoryRegistry(existingActions);
  const stages = input.related ?? [];
  let stageIndex = 0;
  const commitSavedAction = createStagedDiscoveryCommitter({
    expectedActions: stages.length + 1,
    staged: stagedActions,
    persistent: store.siteActions,
  });
  await registerActionDiscoveryTools(ctx, {
    session: createActionDiscoverySession({
      registry: stagedActions,
      siteId: input.siteId,
      allowedSafety: input.allowedSafety,
    }),
    ...(stages.length
      ? {
          nextAction: async () => {
            const next = stages[stageIndex++];
            if (!next) return undefined;
            return {
              session: createActionDiscoverySession({
                registry: stagedActions,
                siteId: next.siteId,
                allowedSafety: next.allowedSafety,
              }),
              expectedActionName: next.expectedActionName!,
              task: next.task,
              taskInputs: next.inputs,
              prerequisiteActions: next.prerequisiteActions,
              allowRepresentativeItem: next.allowRepresentativeItem === true,
              existingActions: await stagedActions.list(input.siteId),
            };
          },
        }
      : {}),
    onSaved: commitSavedAction,
    startUrl: input.startUrl,
    task: input.task,
    existingActions,
    taskInputs: input.inputs,
    prerequisiteActions: input.prerequisiteActions,
    allowRepresentativeItem: input.allowRepresentativeItem === true,
    allowedSafety: input.allowedSafety,
    onPrerequisiteSuccess: async (name) => {
      const action = existingActions.find((candidate) => candidate.name === name);
      if (action !== undefined) {
        await recordSuccessfulSiteActionReuse(
          store.siteActions,
          action.id,
          Date.now(),
          action.version,
          (action.implementations ?? [action.implementation]).every((implementation) =>
            Boolean(implementation.precondition && implementation.completion),
          ),
        );
      }
    },
    ...(input.expectedActionName === undefined
      ? {}
      : { expectedActionName: input.expectedActionName }),
  });
}

export function createStagedDiscoveryCommitter(input: {
  expectedActions: number;
  staged: SiteActionRegistry;
  persistent: SiteActionRegistry;
}): (result: unknown) => Promise<unknown> {
  if (!Number.isSafeInteger(input.expectedActions) || input.expectedActions < 1) {
    throw new Error("Expected discovery action count must be a positive integer");
  }
  const saved: unknown[] = [];
  return async (result: unknown) => {
    saved.push(result);
    if (saved.length < input.expectedActions) {
      return {
        status: "action-saved",
        action: result,
      };
    }
    if (saved.length > input.expectedActions) {
      throw new Error("All staged discovery actions have already been committed");
    }
    for (const item of saved) {
      const id = savedActionId(item);
      const action = await input.staged.get(id);
      if (action === undefined) throw new Error(`Staged action ${id} is unavailable`);
      await input.persistent.save(action);
    }
    return input.expectedActions === 1 ? result : { status: "discovered-actions", actions: saved };
  };
}

function savedActionId(value: unknown): string {
  if (value === null || typeof value !== "object") throw new Error("Saved action is missing");
  const action = (value as { action?: unknown }).action;
  if (action === null || typeof action !== "object") throw new Error("Saved action is missing");
  const id = (action as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) throw new Error("Saved action id is missing");
  return id;
}

const semanticBindingParameter = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", required: true, const: "input" },
        key: { type: "string", required: true },
        prefix: { type: "string" },
        suffix: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", required: true, const: "literal" },
        value: { type: "string", required: true },
      },
    },
  ],
} as const;

const locatorParameter = {
  type: "object",
  additionalProperties: false,
  properties: {
    strategy: { type: "string", required: true, enum: ["role", "text", "label", "test-id", "css"] },
    role: { type: "string" },
    name: { type: "string" },
    text: { type: "string" },
    label: { type: "string" },
    testId: { type: "string" },
    selector: { type: "string" },
    exact: { type: "boolean" },
    bindings: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: semanticBindingParameter,
        text: semanticBindingParameter,
        label: semanticBindingParameter,
        testId: semanticBindingParameter,
      },
      description:
        'Keys are semantic fields, never input names. Example: {"name":{"kind":"input","key":"itemNumber","prefix":"Go to item ","suffix":""}}. With itemNumber=7 this matches "Go to item 7". Omit prefix/suffix to replace the whole field. No placeholder interpolation or CSS binding.',
    },
    attribute: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", required: true },
        value: {
          required: true,
          oneOf: [
            { type: "string" },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", required: true, const: "literal" },
                value: { type: "string", required: true },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", required: true, const: "input" },
                key: { type: "string", required: true },
              },
            },
          ],
        },
      },
      description:
        'Attribute filter intersected with the target, e.g. {name:"href",value:{kind:"literal",value:"/destination"}}. For caller values use {kind:"input",key:"item.href"}.',
    },
    within: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", required: true, enum: ["form", "landmark", "container"] },
        name: { type: "string" },
        role: { type: "string" },
        locator: {
          type: "object",
          additionalProperties: true,
          description: "Container locator with optional input bindings or attribute value.",
        },
      },
    },
  },
} as const;

const listFieldParameter = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        key: { type: "string", required: true },
        optional: { type: "boolean" },
        source: { type: "string", required: true, enum: ["attr", "url"] },
        name: {
          type: "string",
          required: true,
          description:
            'Attribute name, for example href. Use source "url" for navigation hrefs and downloadable src/hrefs so references remain absolute after leaving the page.',
        },
        locator: locatorParameter,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        key: { type: "string", required: true },
        optional: { type: "boolean" },
        source: { type: "string", required: true, const: "text" },
        locator: locatorParameter,
      },
    },
  ],
} as const;

const scalarContractFieldParameter = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", required: true },
    type: {
      type: "string",
      required: true,
      enum: ["string", "number", "boolean"],
    },
    format: {
      type: "string",
      enum: ["decimal-point", "decimal-comma", "currency-decimal-point", "currency-decimal-comma"],
    },
    optional: { type: "boolean" },
    description: { type: "string" },
  },
} as const;

const contractFieldParameter = {
  oneOf: [
    scalarContractFieldParameter,
    {
      type: "object",
      additionalProperties: false,
      properties: {
        key: { type: "string", required: true },
        type: { type: "string", required: true, const: "object" },
        optional: { type: "boolean" },
        description: { type: "string" },
        properties: {
          type: "array",
          required: true,
          items: scalarContractFieldParameter,
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        key: { type: "string", required: true },
        type: { type: "string", required: true, const: "array-object" },
        optional: { type: "boolean" },
        description: { type: "string" },
        properties: {
          type: "array",
          required: true,
          items: scalarContractFieldParameter,
        },
      },
    },
  ],
} as const;

const conditionParameter = {
  description:
    'Pass a condition object directly. Use {kind:"count",locator,count:1,comparison:"gte"} for a nonempty collection. visible/enabled/text/attribute/changed require a unique target. all/any contain condition objects in conditions. JSON strings are also accepted.',
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          required: true,
          enum: [
            "all",
            "any",
            "url",
            "count",
            "visible",
            "enabled",
            "text",
            "attribute",
            "changed",
          ],
        },
        locator: locatorParameter,
        elementRef: { type: "string" },
        value: { type: "json" },
        count: { type: "number" },
        comparison: { type: "string", enum: ["equals", "contains", "gte", "lte"] },
        name: { type: "string" },
        attribute: { type: "string" },
        conditions: { type: "array", items: { type: "json" } },
      },
    },
    { type: "string" },
  ],
} as const;

const stepParameter = {
  type: "object",
  required: true,
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    type: {
      type: "string",
      required: true,
      enum: ["navigate", "fill", "select", "click", "extract-text", "extract-list"],
    },
    safety: { type: "string", enum: ["read-only", "browser-local", "external-side-effect"] },
    url: { type: "string" },
    value: { type: "string" },
    valueKind: { type: "string", enum: ["literal", "input"] },
    valueKey: { type: "string" },
    output: { type: "string" },
    previewId: {
      type: "string",
      description:
        "For extraction, use readText.previewId or previewList.previewId and omit locator and fields. List output schemas are derived from the validated preview; specify output to name the result.",
    },
    ready: conditionParameter,
    completion: conditionParameter,
    empty: conditionParameter,
    locator: locatorParameter,
    elementRef: {
      type: "string",
      description:
        "Observed element reference. The host compiles its locator; omit locator when using this.",
    },
    expectedLabel: {
      type: "string",
      description: "Optional label check for an observed elementRef; not persisted in the action.",
    },
    fields: {
      type: "array",
      items: listFieldParameter,
      description:
        'Extract-list fields. Use source "url" with name "src" for an absolute browser-loaded image URL.',
    },
  },
} as const;

const renderJson = (_args: unknown, value: unknown) => [
  { type: "text" as const, text: JSON.stringify(value) },
];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function asJson(value: unknown): { [key: string]: Json } {
  const result = JSON.parse(JSON.stringify(value)) as { [key: string]: Json };
  return { ok: true, ...result };
}

export async function registerActionDiscoveryTools(
  ctx: Context,
  input: {
    session: ActionDiscoverySession;
    startUrl: string;
    task: string;
    browser?: Browser;
    expectedActionName?: string;
    existingActions?: SiteActionDefinition[];
    taskInputs?: Record<string, unknown>;
    prerequisiteActions?: string[];
    allowRepresentativeItem?: boolean;
    allowedSafety?: StepSafety[];
    onPrerequisiteSuccess?: (name: string) => Promise<void>;
    nextAction?: () => Promise<
      | {
          session: ActionDiscoverySession;
          expectedActionName: string;
          task: string;
          taskInputs: Record<string, unknown>;
          prerequisiteActions: string[];
          allowRepresentativeItem: boolean;
          existingActions: SiteActionDefinition[];
        }
      | undefined
    >;
    onSaved?: (result: unknown) => Promise<unknown>;
  },
): Promise<void> {
  const owned = input.browser === undefined;
  const browser = input.browser ?? (await openAgentBrowser());
  const sharedPage = await sharedAgentPage(browser);
  const { tools, context, close } = createDiscoveryTools(
    browser,
    {
      id: "action-discovery",
      task: input.task,
      startUrl: input.startUrl,
      goal: { type: "agent-confirmed" },
      constraints: DEFAULT_DISCOVERY_CONSTRAINTS,
      inputs: input.taskInputs ?? {},
    },
    sharedPage ? { page: sharedPage } : {},
  );
  const exampleLocator = (locator: LocatorDefinition) =>
    bindLocator(locator, input.taskInputs ?? {});
  const controlState = async (locator: LocatorDefinition) => {
    if (!context.page) return undefined;
    const target = resolveLocator(context.page, exampleLocator(locator));
    if ((await target.count()) !== 1) return undefined;
    return target.evaluate((element) => ({
      text: element.textContent?.slice(0, 500) ?? "",
      ...(element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? { value: element.value }
        : {}),
      attributes: Object.fromEntries(
        Array.from(element.attributes)
          .filter((attribute) =>
            /^(aria-|data-)|^(class|style|title|value|checked|selected|disabled)$/.test(
              attribute.name,
            ),
          )
          .map((attribute) => [attribute.name, attribute.value]),
      ),
    }));
  };
  const conditionDiagnostics = async (condition: Condition): Promise<unknown> => {
    if (!context.page) throw new Error("Exploration page is unavailable");
    if ("conditions" in condition)
      return {
        kind: condition.kind,
        conditions: await Promise.all(condition.conditions.map(conditionDiagnostics)),
      };
    if (condition.kind === "url") return { kind: "url", actual: context.page.url() };
    const target = resolveLocator(context.page, exampleLocator(condition.locator));
    const matches = await target.count();
    const attribute =
      condition.kind === "attribute"
        ? condition.name
        : condition.kind === "changed"
          ? condition.attribute
          : undefined;
    return {
      kind: condition.kind,
      locator: condition.locator,
      matches,
      ...(matches === 1
        ? {
            state: await controlState(condition.locator),
            ...(attribute === undefined
              ? {}
              : { attribute, actual: await target.getAttribute(attribute, { timeout: 100 }) }),
          }
        : {
            alternatives: await locatorAlternatives(
              context.page,
              exampleLocator(condition.locator),
            ),
          }),
    };
  };
  const validatedLocators = new Set<string>();
  const validatedClickCompletions = new Set<string>();
  let lastClick: { revision: number; before: BeforeValues; locator: LocatorDefinition } | undefined;
  const validatedLists = new Set<string>();
  const previewedText = new Map<string, string>();
  const previewedLists = new Map<string, unknown>();
  const observations: unknown[] = [];
  const performedClicks: LocatorDefinition[] = [];
  const performedOperations: unknown[] = [];
  const performedTargets = new Map<unknown, ElementHandle>();
  const openedTabs: unknown[] = [];
  let otherEffects = false;
  const evidence = new EvidenceStore();
  const overviewHistory = new OverviewHistory();
  const elementReferences = new ElementReferences();
  const referencedLocator = async (args: {
    elementRef?: string;
    locator?: unknown;
    expectedLabel?: string;
  }) => {
    if (args.elementRef) {
      if (args.locator) throw new Error("Use elementRef or locator, not both");
      if (!context.page) throw new Error("Exploration page is unavailable");
      if (args.expectedLabel !== undefined)
        elementReferences.assertLabel(args.elementRef, args.expectedLabel);
      return elementReferences.resolve(context.page, args.elementRef);
    }
    if (!args.locator) throw new Error("Provide elementRef from the overview or a locator");
    return toLocator(args.locator as LocatorInput);
  };
  const referenceOverview = async (snapshot: unknown, full = false) => {
    const references = context.page ? await elementReferences.capture(context.page, snapshot) : {};
    const referenced = {
      ...(elementReferences.referenceSnapshot(snapshot) as Record<string, unknown>),
      ...references,
    };
    return full ? referenced : presentObservation(referenced, evidence);
  };
  const expandConditionReferences = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(expandConditionReferences);
    const record = value as Record<string, unknown>;
    if (typeof record.elementRef === "string") {
      if (record.locator) throw new Error("Use elementRef or locator in a condition, not both");
      const { elementRef, ...rest } = record;
      return { ...rest, locator: elementReferences.definition(elementRef) };
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, expandConditionReferences(child)]),
    );
  };
  const parseReferencedCondition = (value: unknown) =>
    parseCondition(
      expandConditionReferences(typeof value === "string" ? JSON.parse(value) : value),
    );
  const previews = new Map<string, LocatorDefinition>();
  const listPreviews = new Map<string, Extract<Step, { type: "extract-list" }>>();
  const compileStep = (
    raw: ActionStepInput & { previewId?: string; elementRef?: string; expectedLabel?: string },
  ) => {
    if (raw.expectedLabel !== undefined) {
      if (!raw.elementRef) throw new Error("expectedLabel requires an elementRef");
      elementReferences.assertLabel(raw.elementRef, raw.expectedLabel);
      const { expectedLabel: _label, ...step } = raw;
      raw = step;
    }
    if (raw.elementRef) {
      if (raw.locator || raw.previewId) throw new Error("Use elementRef alone for the step target");
      const { elementRef, ...rest } = raw;
      raw = { ...rest, locator: elementReferences.definition(elementRef) as LocatorInput };
    }
    raw = {
      ...raw,
      ...Object.fromEntries(
        ["ready", "completion", "empty"].flatMap((key) => {
          const value = raw[key as "ready" | "completion" | "empty"];
          return value === undefined ? [] : [[key, parseReferencedCondition(value)]];
        }),
      ),
    };
    if (!raw.previewId) return toActionStep(raw);
    if (raw.locator || raw.fields)
      throw new Error(
        "Use previewId alone; omit locator and fields to compile the previewed target",
      );
    if (raw.type === "extract-list") {
      const preview = listPreviews.get(raw.previewId);
      if (!preview)
        throw new Error("Unknown or expired previewId; preview the current action's list first");
      if (raw.ready !== undefined || raw.empty !== undefined)
        throw new Error(
          "List previewId already supplies ready and empty conditions; set them in previewList",
        );
      return {
        ...structuredClone(preview),
        id: raw.id,
        output: raw.output ?? raw.id,
        ...(raw.completion === undefined ? {} : { completion: parseCondition(raw.completion) }),
      };
    }
    if (raw.type !== "extract-text") throw new Error("previewId is only valid for extraction");
    const locator = previews.get(raw.previewId);
    if (!locator)
      throw new Error("Unknown or expired previewId; preview the current action's text first");
    return toActionStep({ ...raw, locator: locator as LocatorInput });
  };
  const rememberLocator = (locator: LocatorDefinition) => {
    validatedLocators.add(locatorKey(locator));
  };
  let explorationActions = 0;
  const markExplore = () => {
    explorationActions += 1;
    if (savedCurrent) readyPrefix = undefined;
  };
  const sessionDirectory = process.env.DSH_POC_SESSION_DIR;
  if (sessionDirectory !== undefined) {
    await writeFile(
      join(sessionDirectory, "mosaik-first-browser-action.json"),
      JSON.stringify({ at: Date.now(), kind: "discovery-navigation" }),
      "utf8",
    );
  }
  let readyPrefix: string[] | undefined;
  let savedCurrent = false;
  let initialStage = true;
  const completedPrerequisites = new Set<string>();
  const initialize = async () => {
    context.request.inputs = input.taskInputs ?? {};
    performedClicks.length = 0;
    performedOperations.length = 0;
    await Promise.allSettled([...performedTargets.values()].map((element) => element.dispose()));
    performedTargets.clear();
    openedTabs.length = 0;
    otherEffects = false;
    validatedLocators.clear();
    validatedClickCompletions.clear();
    lastClick = undefined;
    validatedLists.clear();
    previewedText.clear();
    previews.clear();
    listPreviews.clear();
    previewedLists.clear();
    explorationActions = 0;
    const canReusePrefix =
      readyPrefix !== undefined &&
      JSON.stringify(readyPrefix) === JSON.stringify(input.prerequisiteActions ?? []);
    const continuingBatch = !initialStage;
    const keepObservedPage =
      initialStage &&
      sharedPage &&
      !input.prerequisiteActions?.length &&
      sharedPage.url() !== "about:blank";
    initialStage = false;
    if (
      !continuingBatch &&
      !canReusePrefix &&
      !keepObservedPage &&
      context.page?.url() !== input.startUrl
    )
      await tools.exploreNavigate({ url: input.startUrl });
    let prefixSummary = "none";
    const prerequisiteActions = (
      (input.prerequisiteActions?.length ?? 0) > 0
        ? input.prerequisiteActions!
        : continuingBatch
          ? []
          : directlyBindableSearchPrefix(input.existingActions ?? [], input.taskInputs ?? {})
    ).filter((name) => !continuingBatch || !completedPrerequisites.has(name));
    if (keepObservedPage) {
      prefixSummary = "current planning page, no prerequisite replay";
    } else if (canReusePrefix) {
      prefixSummary = `verified current state after ${readyPrefix!.join(", ")}`;
    } else if (continuingBatch && prerequisiteActions.length === 0) {
      prefixSummary =
        "current batch page; saved prerequisites are not replayed. Inspect readiness for the next operation on this page";
    } else if (prerequisiteActions.length > 0) {
      if (context.page === undefined) throw new Error("Exploration page is unavailable");
      await writeFirstSemanticActionMarker(sessionDirectory);
      const prefix = await executeReusablePrefix({
        page: context.page,
        actions: input.existingActions ?? [],
        names: prerequisiteActions,
        allowRepresentativeItem: input.allowRepresentativeItem === true,
        taskInputs: input.taskInputs ?? {},
        ...(input.onPrerequisiteSuccess === undefined
          ? {}
          : { onSuccess: input.onPrerequisiteSuccess }),
      });
      for (const name of prefix.completed) completedPrerequisites.add(name);
      explorationActions += prefix.completed.length;
      prefixSummary = `reused ${prefix.completed.join(", ") || "none"}`;
      if (prefix.unresolved !== undefined) {
        prefixSummary += `. Unresolved prerequisite ${prefix.unresolved}: choose a relevant observed candidate through exploration before learning the requested action. The unresolved action and later prerequisites have NOT run. Observed prerequisite outputs: ${JSON.stringify(prefix.outputs).slice(0, 16000)}`;
      }
    } else {
      const overview = withoutDegraded(toPageSnapshot(await tools.getOverview()));
      const bootstrapped = await bootstrapSafeSearch({
        tools,
        overview,
        taskInputs: input.taskInputs ?? {},
        ...(input.expectedActionName === undefined
          ? {}
          : { expectedActionName: input.expectedActionName }),
        ...(input.allowedSafety === undefined ? {} : { allowedSafety: input.allowedSafety }),
        beforeAction: async () => writeFirstSemanticActionMarker(sessionDirectory),
        onValidated: rememberLocator,
      });
      if (bootstrapped) {
        explorationActions += 2;
        prefixSummary = "safe search interaction from the unique labeled form";
      }
    }
    const initialOverview = overviewHistory.present(
      await referenceOverview(withoutDegraded(toPageSnapshot(await tools.getOverview()))),
    );
    return {
      prefix: prefixSummary,
      task: input.task,
      expectedActionName: input.expectedActionName,
      overview: initialOverview,
    };
  };
  const initial = await initialize();
  const validateStepEvidence = async (step: Step) => {
    try {
      assertStepWasValidated(step, validatedLocators, validatedLists);
    } catch (error) {
      if (
        context.page &&
        (step.type === "click" || step.type === "fill" || step.type === "select")
      ) {
        const alternatives = await locatorAlternatives(context.page, exampleLocator(step.locator));
        if (alternatives.length > 0)
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}. Observed alternatives: ${JSON.stringify(alternatives)}. Choose by the requested context, test and explore that exact locator, then resubmit with it.`,
          );
      }
      throw error;
    }
  };
  ctx.systemPrompt.section({
    name: "mosaik:initial-action-overview",
    order: 10,
    text: `Initial exploration state (do not repeat the prefix): ${JSON.stringify(initial)}`,
  });
  const completeSave = async (result: unknown) => {
    const draft = input.session.preview().draft;
    const outputs: Record<string, unknown> = {};
    for (const step of draft.steps) {
      if (step.type === "extract-text" && previewedText.has(locatorKey(step.locator)))
        outputs[step.output] = previewedText.get(locatorKey(step.locator));
      if (
        step.type === "extract-list" &&
        previewedLists.has(listStepKey(step.locator, step.fields))
      )
        outputs[step.output] = previewedLists.get(listStepKey(step.locator, step.fields));
    }
    observations.push({
      name: draft.name,
      outputs,
      page: context.page?.url(),
      inputs: input.taskInputs ?? {},
      performedOperations: [...performedOperations],
      observedControls: await Promise.all(
        performedOperations.slice(-8).flatMap((operation) => {
          const locator = (operation as { locator?: LocatorDefinition }).locator;
          return locator
            ? [
                (async () => ({ locator, state: await controlState(locator) }))().catch(() => ({
                  locator,
                })),
              ]
            : [];
        }),
      ),
      // Only actual successful clicks count. Locator probes cannot authorize skipping execution.
      ...(!otherEffects ? { performedClicks: [...performedClicks] } : {}),
      completion: draft.completion ?? draft.steps.at(-1)?.completion,
      ...(context.page
        ? { overview: withoutDegraded(toPageSnapshot(await tools.getOverview())) }
        : {}),
    });
    if (sessionDirectory && context.page)
      await writeFile(
        join(sessionDirectory, "mosaik-observations.json"),
        JSON.stringify({
          observations,
          pageNavigation: await collectPageNavigationEvidence(context.page),
        }),
      );
    const finalCompletion = draft.completion ?? draft.steps.at(-1)?.completion;
    const completionStillHolds =
      finalCompletion !== undefined &&
      context.page !== undefined &&
      (await observeCondition(
        context.page,
        finalCompletion,
        input.taskInputs ?? {},
        lastClick?.revision === explorationActions ? lastClick.before : undefined,
      ));
    readyPrefix =
      completionStillHolds ||
      draft.steps.every(
        (step) =>
          step.type === "extract-text" ||
          step.type === "extract-list" ||
          (step.type === "navigate" &&
            (typeof step.url === "string"
              ? step.url
              : step.url.kind === "literal"
                ? step.url.value
                : undefined) === context.page?.url()),
      )
        ? [...(input.prerequisiteActions ?? []), draft.name!]
        : undefined;
    completedPrerequisites.add(draft.name!);
    savedCurrent = true;
    const saved = input.onSaved ? await input.onSaved(result) : result;
    const next =
      (saved as { status?: string }).status === "discovered-actions"
        ? undefined
        : await input.nextAction?.();
    if (!next) return saved;
    Object.assign(input, next);
    savedCurrent = false;
    return {
      ...(saved as Record<string, unknown>),
      status: "action-saved",
      nextAction: await initialize(),
    };
  };
  ctx.effect(
    () => async () => {
      await Promise.allSettled([...performedTargets.values()].map((element) => element.dispose()));
      await elementReferences.close();
      await close();
      if (owned) await browser.close();
    },
    "dsh-action-discovery.browser",
  );

  ctx.tools.register(
    defineTool({
      name: "setExampleInputs",
      description:
        "Supply observed example values for reusable action inputs as a JSON object before exploring parameterized locators. These are discovery bindings only, never defaults in the saved action. Use actual task or observed values. Changing examples invalidates affected input-bound locators. Unchanged observed locators remain validated; do not revisit a page to retest them.",
      parameters: {
        values: {
          oneOf: [{ type: "object", additionalProperties: true }, { type: "string" }],
          required: true,
        },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const values: unknown =
          typeof args.values === "string" ? JSON.parse(args.values) : args.values;
        if (!values || typeof values !== "object" || Array.isArray(values))
          throw new Error("Example inputs must be an object");
        if (savedCurrent) throw new Error("Begin the next action before changing examples");
        const previousInputs = input.taskInputs ?? {};
        input.taskInputs = { ...input.taskInputs, ...values };
        context.request.inputs = input.taskInputs;
        for (const key of validatedLocators) {
          try {
            const locator = JSON.parse(key) as LocatorDefinition;
            if (!isDeepStrictEqual(bindLocator(locator, previousInputs), exampleLocator(locator)))
              validatedLocators.delete(key);
          } catch {
            validatedLocators.delete(key);
          }
        }
        validatedClickCompletions.clear();
        validatedLists.clear();
        previewedText.clear();
        previewedLists.clear();
        previews.clear();
        listPreviews.clear();
        lastClick = undefined;
        return asJson({ inputs: input.taskInputs });
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "requireCapability",
      description:
        "Report a missing independent prerequisite to composition before performing it. For example, if selecting an existing item requires creating a missing item first, report creation as a separate capability. This ends this discovery attempt so composition can add that operation to the workflow instead of hiding it in the current action.",
      parameters: {
        name: { type: "string", required: true },
        intent: { type: "string", required: true },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      execute: async (args) =>
        asJson({
          status: "refused",
          reason: `Missing separate capability ${args.name}: ${args.intent}. Add it as its own workflow stage before ${input.expectedActionName ?? "the current action"}; do not embed its mutation in that action.`,
        }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "readEvidence",
      description:
        "Read a page of full preview text by its evidenceId. Use nextOffset to continue; limit is at most 16000 characters.",
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
  const validateCandidate = async (
    draft: import("../../capabilities/action-discovery.js").ActionDiscoveryDraft,
  ) => {
    if (savedCurrent) throw new Error("Current action is already saved; begin the next action");
    if (explorationActions === 0) {
      throw new Error("Explore the page before finishing a site action");
    }
    if (context.page !== undefined) {
      await assertConditionCardinality(context.page, draft.precondition);
      await assertConditionCardinality(context.page, draft.completion);
      for (const step of draft.steps) {
        await assertConditionCardinality(context.page, step.ready);
        await assertConditionCardinality(context.page, step.completion);
      }
    }
    for (const [key, schema] of Object.entries(draft.inputs ?? {})) {
      if (input.taskInputs?.[key] === undefined) continue;
      const value = coerceValue(schema, input.taskInputs[key], key);
      if (String(value) !== String(input.taskInputs[key]))
        throw new Error(
          `Example ${key} does not match its declared type. Set the correctly typed example before exploring.`,
        );
      input.taskInputs[key] = value;
    }
    const expected = draft.steps.map((step) => discoveryOperation(step, input.taskInputs ?? {}));
    if (
      openedTabs.some((operation) => !expected.some((step) => isDeepStrictEqual(step, operation)))
    )
      throw new Error(
        "Include the explored tab activation in this action's steps before the control it exposed. Saving only the final control depends on transient exploration state. Resubmit without clicking again.",
      );
    if (draft.safety === "browser-local") {
      let observedIndex = 0;
      for (const step of draft.steps) {
        if (step.type !== "click" && step.type !== "fill" && step.type !== "select") continue;
        const operation = discoveryOperation(step, input.taskInputs ?? {});
        while (observedIndex < performedOperations.length) {
          const observed = performedOperations[observedIndex];
          if (isDeepStrictEqual(observed, operation)) {
            if ("locator" in step) rememberLocator(step.locator);
            break;
          }
          const target = performedTargets.get(observed);
          if (
            target &&
            context.page &&
            step.type === "click" &&
            (observed as { type?: string }).type === "click"
          ) {
            try {
              const candidate = resolveLocator(context.page, step.locator, input.taskInputs ?? {});
              if (
                (await candidate.count()) === 1 &&
                (await candidate.evaluate(
                  (node, original) => node === original && node.isConnected,
                  target,
                ))
              ) {
                performedOperations[observedIndex] = operation;
                performedTargets.set(operation, target);
                rememberLocator(step.locator);
                break;
              }
            } catch {
              /* Detached observations cannot prove a new locator. */
            }
          }
          observedIndex++;
        }
        if (observedIndex === performedOperations.length)
          throw new Error(
            `Step ${step.id} has not been performed with these inputs. A locator test only finds the control. Explore this step once, inspect its result, and resubmit without repeating earlier successful steps.`,
          );
        observedIndex++;
      }
    }
    for (const step of draft.steps) {
      assertReusableTextExtraction(step, previewedText);
      await validateStepEvidence(step);
      if (step.type === "click") {
        for (const completion of [
          step.completion,
          ...(step === draft.steps.at(-1) ? [draft.completion] : []),
        ]) {
          if (
            containsChangedCondition(completion) &&
            !validatedClickCompletions.has(JSON.stringify([step.locator, completion]))
          )
            throw new Error(
              `Step ${step.id}: changed completion was not observed. Pass this completion JSON to exploreClick and check ok before saving. For selecting an existing state, prefer an observed attribute such as aria-selected or aria-pressed; clicking an already selected control need not change its text.`,
            );
        }
      }
    }
    for (const step of draft.steps) {
      const owner = findExistingStepOwner(input.existingActions ?? [], step);
      if (owner)
        throw new Error(
          `Step is already provided by ${owner}; call that action from the generated automation`,
        );
    }
  };
  ctx.tools.register(
    defineTool({
      name: "submitAction",
      description:
        "Validate and save a complete reusable action atomically. Prefer previewId after successful extraction previews; omit list output declarations to derive their array-of-object schemas. Pass conditions as objects. A rejected submission leaves the existing draft and library unchanged. Correct it without repeating successful browser operations. A successful save automatically returns nextAction with the next capability and current overview, or the final discovered result. Continue using nextAction without another overview call.",
      parameters: {
        name: { type: "string", required: true },
        description: { type: "string", required: true },
        contexts: {
          type: "array",
          items: { type: "string" },
          description:
            "Reusable page or UI state, such as current document editor. Exclude task-specific object IDs, page numbers, colors, and incidental URLs.",
        },
        safety: {
          type: "string",
          required: true,
          enum: ["read-only", "browser-local", "external-side-effect"],
        },
        inputs: { type: "array", required: true, items: contractFieldParameter },
        outputs: { type: "array", items: contractFieldParameter },
        steps: {
          type: "array",
          required: true,
          items: {
            type: stepParameter.type,
            additionalProperties: false,
            properties: stepParameter.properties,
          },
        },
        precondition: conditionParameter,
        completion: conditionParameter,
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        const candidate = {
          siteId: input.session.preview().draft.siteId,
          name: input.expectedActionName ?? args.name,
          description: args.description,
          ...(args.contexts ? { contexts: args.contexts } : {}),
          safety: args.safety as StepSafety,
          inputs: toActionSchema(args.inputs as ContractFieldInput[]),
          outputs: toActionSchema((args.outputs ?? []) as ContractFieldInput[]),
          steps: args.steps.map((step) =>
            compileStep({
              ...step,
              ...((step.type === "click" || step.type === "navigate") && step.safety === undefined
                ? { safety: args.safety as StepSafety }
                : {}),
            } as unknown as ActionStepInput),
          ),
          ...(args.precondition
            ? {
                precondition: parseReferencedCondition(args.precondition),
              }
            : {}),
          ...(args.completion ? { completion: parseReferencedCondition(args.completion) } : {}),
        };
        for (const [index, step] of candidate.steps.entries()) {
          if (step.type !== "extract-list" || !args.steps[index]?.previewId) continue;
          const inferred: ActionType = {
            type: "array",
            items: {
              type: "object",
              properties: Object.fromEntries(
                Object.entries(step.fields).map(([key, field]) => [
                  key,
                  { type: "string", ...(field.optional ? { optional: true } : {}) },
                ]),
              ),
            },
          };
          const declared = candidate.outputs[step.output];
          if (declared && !isDeepStrictEqual(declared, inferred))
            throw new Error(
              `Output ${step.output} conflicts with the validated list preview schema; omit its declaration to use the inferred array of objects`,
            );
          candidate.outputs[step.output] = inferred;
        }
        validateCondition(candidate.precondition);
        validateCondition(candidate.completion);
        await validateCandidate(candidate);
        const result = await input.session.submit(candidate);
        return asJson(
          await completeSave({
            ...result,
            ...(context.page
              ? { observedPage: { url: context.page.url(), title: await context.page.title() } }
              : {}),
          }),
        );
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "getOverview",
      description:
        "Return page fields directly, not inside overview. Default observations sample long arrays and omit unchanged fields. full=true returns a standalone unsampled snapshot with complete arrays, including observed structural collections. Use it when a sample is insufficient; do not broaden a failed collection to all page links.",
      parameters: { full: { type: "boolean" } },
      timeoutMs: 15_000,
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => false,
      execute: async (args) =>
        asJson(
          overviewHistory.present(
            await referenceOverview(
              withoutDegraded(toPageSnapshot(await tools.getOverview())),
              args.full === true,
            ),
            args.full === true,
          ),
        ),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "getCurrentUrl",
      description: "Return the current exploration page URL.",
      parameters: {},
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async () => asJson(await tools.getCurrentUrl()),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "bindElement",
      description:
        "Make an observed choice reusable while preserving its host-compiled scope. Call setExampleInputs first. Returns a validated locator for submission; no click or additional locator test is needed if this exact element was already clicked. Prefer this over reconstructing locators for duplicate names such as fill and border palettes.",
      parameters: {
        elementRef: { type: "string", required: true },
        inputKey: { type: "string", required: true },
        prefix: { type: "string" },
        suffix: { type: "string" },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        if (!context.page) throw new Error("Exploration page is unavailable");
        const locator = await elementReferences.bind(
          context.page,
          args.elementRef,
          {
            kind: "input",
            key: args.inputKey,
            ...(args.prefix === undefined ? {} : { prefix: args.prefix }),
            ...(args.suffix === undefined ? {} : { suffix: args.suffix }),
          },
          input.taskInputs ?? {},
        );
        rememberLocator(locator);
        return asJson({ locator, target: elementReferences.describe(args.elementRef) });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "testLocator",
      description:
        "Test locator cardinality without recording a step. cardinality=one (default) requires a unique, visible, enabled target. cardinality=many checks that the collection is nonempty; it does not validate extraction fields or authorize single-target steps. For extract-list, use previewList directly to validate rows and fields; multiple matches are expected.",
      parameters: {
        locator: locatorParameter,
        elementRef: { type: "string" },
        cardinality: { type: "string", enum: ["one", "many"] },
      },
      timeoutMs: 15_000,
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const locator = await referencedLocator(args);
        const result = await tools.testLocator({ locator: exampleLocator(locator) });
        if (args.cardinality === "many") {
          return asJson({
            ok: result.matches > 0,
            cardinality: "many",
            matches: result.matches,
            next: "Use previewList with the collection locator and fields before compiling extract-list.",
          });
        }
        if (result.unique && result.visible && result.enabled) {
          rememberLocator(locator);
          markExplore();
        }
        const alternatives =
          !result.unique && context.page
            ? await locatorAlternatives(context.page, exampleLocator(locator))
            : [];
        let attributeTargets: unknown[] | undefined;
        if (result.matches === 0 && locator.attribute?.name === "href" && context.page) {
          const { attribute: _attribute, ...base } = exampleLocator(locator);
          attributeTargets = await resolveLocator(context.page, base).evaluateAll((nodes) =>
            nodes.slice(0, 8).map((node) => ({
              text: node.textContent,
              href: node.getAttribute("href"),
              ...(node instanceof HTMLAnchorElement ? { destinationUrl: node.href } : {}),
            })),
          );
        }
        return asJson({
          ...result,
          ...(attributeTargets
            ? {
                attributeTargets,
                attributeHint:
                  "href filters match the literal DOM attribute; destinationUrl is browser-resolved and may differ. Prefer the uniquely named link without an href filter when its destination follows the current item.",
              }
            : {}),
          ...(args.elementRef ? { locator } : {}),
          alternatives,
          ...(result.unique ? { state: await controlState(locator) } : {}),
          cardinality: "one",
          ok: result.unique && result.visible && result.enabled,
          ...(result.matches > 1
            ? {
                next:
                  alternatives.length > 0
                    ? "The original locator is invalid for a single-target action. Choose the alternative whose context matches the requested operation, then call testLocator with that exact alternatives[].locator before exploring or saving it. Do not continue with the ambiguous original locator."
                    : "For a collection, use previewList with rows and fields. For a single target, refine the locator.",
              }
            : {}),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "readText",
      description:
        "Preview a unique extraction locator without recording a step. For instructions/body text use scope=content: heading-only selections expand to an observed content container. Compile with previewId and omit locator: the host uses the exact returned content locator, which may differ from the requested heading locator. Element scope permits titles and returns headingOnly with a contentLocator when available. Returns ok=true with text on success, ok=false when the locator is not unique. Extract-text locators must identify the element structurally and must not constrain the text being returned.",
      parameters: {
        locator: locatorParameter,
        elementRef: { type: "string" },
        scope: {
          type: "string",
          enum: ["element", "content"],
          description:
            "Use content for instructions or body text; element (default) permits a heading/title.",
        },
      },
      timeoutMs: 15_000,
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        let locator = await referencedLocator(args);
        let result = await tools.readText({ locator: exampleLocator(locator) });
        const target =
          result.unique && context.page
            ? await textContentTarget(resolveLocator(context.page, exampleLocator(locator)))
            : undefined;
        if (args.scope === "content" && target?.headingOnly) {
          if (!target.contentLocator)
            return asJson({
              ...result,
              ok: false,
              headingOnly: true,
              next: "Only a heading was found. Select a containing article/main region with the requested content.",
            });
          locator = target.contentLocator;
          result = await tools.readText({ locator });
        }
        let previewId: string | undefined;
        if (result.unique && result.text !== undefined) {
          previewId = randomUUID();
          previews.set(previewId, structuredClone(locator));
          rememberLocator(locator);
          previewedText.set(locatorKey(locator), result.text);
          markExplore();
        }
        return asJson({
          ...result,
          alternatives:
            !result.unique && context.page
              ? await locatorAlternatives(context.page, exampleLocator(locator))
              : [],
          ...(result.text && result.text.length > 4000
            ? {
                text: result.text.slice(0, 2000),
                evidenceId: evidence.add(result.text),
                length: result.text.length,
                truncated: true,
              }
            : {}),
          ...(previewId ? { previewId } : {}),
          ok: result.unique && result.text !== undefined,
          locator,
          ...(args.scope === "content" ? {} : target),
          ...(target?.headingOnly && args.scope !== "content"
            ? {
                next: "This is only a heading. For instructions/body text call readText with scope=content; compile its returned locator.",
              }
            : {}),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "previewList",
      description:
        'Validate and read a collection and its fields without recording a step. Returns {ok:true,previewId,items}. Submit an extract-list step with previewId and output; omit locator, fields, ready, empty and the output contract to reuse validated extraction and derive its array-of-object schema. Multiple row matches are expected. Use elementRef for a single observed image or container, or locator for repeated rows. To read the row itself, omit the field locator. An image reference uses fields:[{key:"imageUrl",source:"url",name:"src"}]. URL fields return an absolute loaded URL.',
      parameters: {
        locator: locatorParameter,
        elementRef: { type: "string" },
        ready: conditionParameter,
        empty: conditionParameter,
        fields: {
          type: "array",
          required: true,
          items: listFieldParameter,
          description:
            'Example: [{ key: "coverUrl", source: "url", name: "src", locator: { strategy: "css", selector: "img" } }, { key: "title", source: "text", locator: { strategy: "css", selector: ".title" } }].',
        },
      },
      timeoutMs: 15_000,
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        await tools.getCurrentUrl();
        if (context.page === undefined) throw new Error("Exploration page is unavailable");
        const locator = await referencedLocator(args);
        const step: Extract<Step, { type: "extract-list" }> = {
          id: "preview-list",
          type: "extract-list",
          safety: "read-only",
          locator,
          output: "items",
          fields: toListFields(args.fields as unknown as ListFieldInput[]),
          ...(args.ready === undefined ? {} : { ready: parseReferencedCondition(args.ready) }),
          ...(args.empty === undefined ? {} : { empty: parseReferencedCondition(args.empty) }),
        };
        const outcome = await executeStep(context.page, step, undefined, input.taskInputs);
        if (!outcome.ok) throw new Error(outcome.message);
        const items = outcome.output?.value ?? [];
        if (!Array.isArray(items) || (items.length === 0 && args.empty === undefined)) {
          throw new Error("List preview matched no items; correct the locator before saving it");
        }
        validatedLists.add(listStepKey(step.locator, step.fields));
        previewedLists.set(listStepKey(step.locator, step.fields), structuredClone(items));
        markExplore();
        const previewId = randomUUID();
        listPreviews.set(previewId, structuredClone(step));
        const serialized = JSON.stringify(items);
        return asJson(
          serialized.length > 8000
            ? {
                ok: true,
                previewId,
                items: evidence.present(items.slice(0, 10)),
                totalItems: items.length,
                evidenceId: evidence.add(serialized),
                truncated: true,
              }
            : { ok: true, previewId, items },
        );
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "exploreNavigate",
      description:
        "Navigate to an observed URL, or use inputKey for a URL supplied by setExampleInputs. For opening a collected item URL, prefer inputKey over locating a same-name link. Returns observedStep with the input binding and the destination overview; submit that step with an id and safety without reconstructing it. Does not add a site action step.",
      timeoutMs: 15_000,
      parameters: {
        url: { type: "string" },
        inputKey: { type: "string" },
        reload: {
          type: "boolean",
          description:
            "Explicitly reload an already open URL; normally the current page is retained.",
        },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        if ((args.url === undefined) === (args.inputKey === undefined))
          throw new Error("Provide exactly one of url or inputKey");
        const url =
          args.inputKey === undefined
            ? args.url!
            : resolveStepValue({ kind: "input", key: args.inputKey }, input.taskInputs);
        previews.clear();
        listPreviews.clear();
        markExplore();
        otherEffects = true;
        const result =
          context.page?.url() === url && args.reload !== true
            ? { ok: true, url, unchanged: true }
            : await tools.exploreNavigate({ url });
        if (!result.ok) return asJson(result);
        return asJson({
          ...result,
          observedStep:
            args.inputKey === undefined
              ? { type: "navigate", url }
              : { type: "navigate", valueKind: "input", valueKey: args.inputKey },
          overview: overviewHistory.present(
            await referenceOverview(withoutDegraded(toPageSnapshot(await tools.getOverview()))),
          ),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "explorePress",
      description:
        "Press Escape while exploring to dismiss a transient popup or menu without navigating or adding a site action step.",
      parameters: { key: { type: "string", required: true, enum: ["Escape"] } },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        previews.clear();
        listPreviews.clear();
        markExplore();
        otherEffects = true;
        await tools.getCurrentUrl();
        if (context.page === undefined) throw new Error("Exploration page is unavailable");
        await context.page.keyboard.press(args.key);
        return asJson({
          ok: true,
          key: args.key,
          url: context.page.url(),
          explorationActions,
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "exploreFill",
      description:
        "Fill an elementRef from the overview, or an advanced locator, while exploring. Does not add a site action step.",
      timeoutMs: 15_000,
      parameters: {
        locator: locatorParameter,
        elementRef: { type: "string" },
        expectedLabel: {
          type: "string",
          description:
            "Required with elementRef: copy the intended target label from the overview. Checked before any browser action.",
        },
        value: { type: "string", required: true },
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        if (args.elementRef && args.expectedLabel === undefined)
          throw new Error(
            "Provide expectedLabel with elementRef so the host can check the intended target before acting. Copy its label from the overview; no browser action was performed.",
          );
        previews.clear();
        listPreviews.clear();
        markExplore();
        otherEffects = true;
        const locator = await referencedLocator(args);
        const result = await tools.exploreFill({
          locator: exampleLocator(locator),
          value: args.value,
        });
        if (result.ok) {
          rememberLocator(locator);
          performedOperations.push({
            type: "fill",
            locator: exampleLocator(locator),
            value: args.value,
          });
        }
        return asJson(result);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "exploreClick",
      description:
        "Click an elementRef from the overview, or an advanced locator, while exploring. No testLocator call is needed before using a reference. Does not add a site action step. Pass a completion object to check the result with a before-value captured before clicking. A changed completion must succeed here before it can be saved. When completion is unknown, omit it on the first exploration and inspect the returned state. If actionPerformed is true but ok is false, the click completed: use checkCondition to correct or recheck completion without clicking again.",
      timeoutMs: 15_000,
      parameters: {
        locator: locatorParameter,
        elementRef: { type: "string" },
        expectedLabel: {
          type: "string",
          description:
            "Required with elementRef: copy the intended target label from the overview. Checked before any browser action.",
        },
        completion: conditionParameter,
      },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        if (args.elementRef && args.expectedLabel === undefined)
          throw new Error(
            "Provide expectedLabel with elementRef so the host can check the intended target before acting. Copy its label from the overview; no browser action was performed.",
          );
        previews.clear();
        listPreviews.clear();
        markExplore();
        const locator = await referencedLocator(args);
        const completion =
          args.completion === undefined ? undefined : parseReferencedCondition(args.completion);
        if (context.page === undefined) throw new Error("Exploration page is unavailable");
        validatedClickCompletions.delete(JSON.stringify([locator, completion]));
        let before: BeforeValues;
        const navigationChange: Condition = {
          kind: "changed",
          locator: { strategy: "css", selector: "body" },
        };
        try {
          before = await captureBefore(context.page, completion, input.taskInputs ?? {});
          await captureBefore(context.page, navigationChange, input.taskInputs ?? {}, before);
        } catch (error) {
          return asJson({
            ok: false,
            url: context.page.url(),
            error: error instanceof Error ? error.message : String(error),
            ...(completion ? { completion: await conditionDiagnostics(completion) } : {}),
            next: "No click was performed. Correct the completion target using its observed matches and alternatives, or omit an unknown completion for the first exploration.",
          });
        }
        const startingUrl = context.page.url();
        const clickTarget = resolveLocator(context.page, exampleLocator(locator));
        const targetHandle =
          (await clickTarget.count()) === 1 ? await clickTarget.elementHandle() : null;
        const isTab = targetHandle
          ? await targetHandle.evaluate((node) => node.getAttribute("role") === "tab")
          : false;
        const result = await tools.exploreClick({
          locator: exampleLocator(locator),
          ...(completion === undefined ? {} : { completion }),
        });
        lastClick = undefined;
        if (result.ok || result.actionPerformed) {
          performedClicks.push(exampleLocator(locator));
          const operation = { type: "click", locator: exampleLocator(locator) };
          performedOperations.push(operation);
          if (targetHandle) performedTargets.set(operation, targetHandle);
          if (isTab) openedTabs.push(operation);
          rememberLocator(locator);
          lastClick = { revision: explorationActions, before, locator };
          if (result.ok && completion)
            validatedClickCompletions.add(JSON.stringify([locator, completion]));
        }
        if (!result.ok && !result.actionPerformed && targetHandle) await targetHandle.dispose();
        if (!result.ok) {
          const alternatives = await locatorAlternatives(context.page, exampleLocator(locator));
          return asJson({
            ...result,
            error: result.error?.split("\n")[0],
            alternatives,
            state: await controlState(locator),
            ...(completion ? { completion: await conditionDiagnostics(completion) } : {}),
            next: result.actionPerformed
              ? "The click completed. Correct or recheck its completion with checkCondition without clicking again. The locator is validated; only the completion remains unconfirmed."
              : "Inspect the current page before retrying. If the locator is ambiguous, choose an observed alternative by its context, test it, and use that exact locator for exploration and the saved step. Do not repeat earlier successful mutations.",
          });
        }
        let observedCompletion: Condition | undefined;
        if (context.page.url() !== startingUrl) {
          if (
            await observeCondition(context.page, navigationChange, input.taskInputs ?? {}, before)
          ) {
            observedCompletion = navigationChange;
            validatedClickCompletions.add(JSON.stringify([locator, navigationChange]));
          }
        }
        return asJson({
          ...result,
          observedStep: {
            type: "click",
            ...(args.elementRef ? { elementRef: args.elementRef } : { locator }),
            ...(observedCompletion ? { completion: observedCompletion } : {}),
          },
          ...(context.page.url() !== startingUrl
            ? {
                next: "Navigation completed. Inspect the destination overview, then submit this observedStep with an id and the action's safety. The original reference remains valid for saving after navigation. A named destination link is reusable from the current item page; do not add an href input or a sample URL completion unless callers must choose a different link. Do not navigate back just to validate or save this click.",
              }
            : {}),
          ...(args.elementRef
            ? { target: elementReferences.describe(args.elementRef) }
            : { target: { locator } }),
          // A positional source locator can match an unrelated node after navigation.
          ...(context.page.url() === startingUrl ? { state: await controlState(locator) } : {}),
          ...(context.page.url() !== startingUrl
            ? {
                overview: overviewHistory.present(
                  await referenceOverview(
                    withoutDegraded(toPageSnapshot(await tools.getOverview())),
                  ),
                  true,
                ),
              }
            : {}),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "checkCondition",
      description:
        "Observe a condition object without clicking or waiting. A condition may use elementRef instead of locator; the host resolves it. Returns satisfied and actual target state, match counts, and alternatives. Use this to correct a completion after a click, or inspect a proposed condition before exploration. Changed requires a before-value captured by the last exploreClick; this tool cannot invent one. A satisfied condition alone does not prove it describes the requested outcome.",
      parameters: { condition: { ...conditionParameter, required: true } },
      output: { schema: { type: "object", additionalProperties: true }, render: renderJson },
      execute: async (args) => {
        if (!context.page) throw new Error("Exploration page is unavailable");
        const condition = parseReferencedCondition(args.condition);
        const click = lastClick?.revision === explorationActions ? lastClick : undefined;
        const satisfied = await observeCondition(
          context.page,
          condition,
          input.taskInputs ?? {},
          click?.before,
        );
        if (satisfied && click)
          validatedClickCompletions.add(JSON.stringify([click.locator, condition]));
        return asJson({ satisfied, observation: await conditionDiagnostics(condition) });
      },
    }),
  );
}

function withoutDegraded(overview: unknown): unknown {
  if (overview === null || typeof overview !== "object" || Array.isArray(overview)) return overview;
  const { degraded: _degraded, ...semantic } = overview as Record<string, unknown>;
  return semantic;
}

async function writeFirstSemanticActionMarker(sessionDirectory: string | undefined): Promise<void> {
  if (sessionDirectory === undefined) return;
  const path = join(sessionDirectory, "mosaik-first-semantic-action.json");
  try {
    await writeFile(path, JSON.stringify({ at: Date.now(), kind: "discovery" }), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function executeReusablePrefix(input: {
  page: import("playwright").Page;
  actions: SiteActionDefinition[];
  names: string[];
  allowRepresentativeItem?: boolean;
  taskInputs: Record<string, unknown>;
  onSuccess?: (name: string) => Promise<void>;
}): Promise<{ completed: string[]; unresolved?: string; outputs: unknown[] }> {
  const byName = new Map(input.actions.map((action) => [action.name, action]));
  const selected = input.names.map((name) => {
    const action = byName.get(name);
    if (action === undefined) throw new Error(`Unknown prerequisite action ${name}`);
    if (action.safety === "external-side-effect") {
      throw new Error(`External-side-effect action ${name} cannot run as a discovery prefix`);
    }
    return action;
  });
  const host = createPlaywrightHost(input.page, selected);
  const priorOutputs: unknown[] = [];
  const completed: string[] = [];
  for (const action of selected) {
    let args: Record<string, unknown>;
    try {
      args = bindPrerequisiteInputs(
        action,
        input.taskInputs,
        priorOutputs,
        input.allowRepresentativeItem === true && action.safety === "read-only",
      );
    } catch (error) {
      if (!(error instanceof PrerequisiteBindingError)) throw error;
      return { completed, unresolved: `${action.name}: ${error.message}`, outputs: priorOutputs };
    }
    try {
      priorOutputs.push(await host.invoke(action.name, args));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Discovery prerequisite ${action.name} failed: ${detail}`, { cause: error });
    }
    completed.push(action.name);
    await input.onSuccess?.(action.name);
  }
  return { completed, outputs: priorOutputs };
}

class PrerequisiteBindingError extends Error {}

function bindPrerequisiteInputs(
  action: SiteActionDefinition,
  taskInputs: Record<string, unknown>,
  priorOutputs: unknown[],
  allowRepresentativeItem = false,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(action.inputs)) {
    if (Object.hasOwn(taskInputs, key)) {
      args[key] = coerceValue(schema, taskInputs[key], `${action.name}.${key}`);
      continue;
    }
    const candidate = selectCompatibleValue(
      schema,
      priorOutputs,
      taskInputs,
      allowRepresentativeItem,
    );
    if (candidate !== undefined) {
      args[key] = candidate;
      continue;
    }
    if (schema.optional !== true) {
      throw new PrerequisiteBindingError(
        `Cannot bind prerequisite input ${action.name}.${key} without guessing`,
      );
    }
  }
  return args;
}

function directlyBindableSearchPrefix(
  actions: SiteActionDefinition[],
  taskInputs: Record<string, unknown>,
): string[] {
  const candidates = actions.filter((action) => {
    if (!action.name.toLowerCase().startsWith("search")) return false;
    if (action.safety === "external-side-effect") return false;
    try {
      bindPrerequisiteInputs(action, taskInputs, []);
      return true;
    } catch {
      return false;
    }
  });
  return candidates.length === 1 ? [candidates[0]!.name] : [];
}

function selectCompatibleValue(
  schema: ActionType,
  values: unknown[],
  taskInputs: Record<string, unknown>,
  allowRepresentativeItem = false,
): unknown {
  const candidates = values.flatMap(nestedValues).flatMap((value) => {
    try {
      return [coerceValue(schema, value, "prerequisite")];
    } catch {
      return [];
    }
  });
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const needles = Object.values(taskInputs)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  const ranked = candidates
    .map((candidate) => ({ candidate, score: semanticCandidateScore(candidate, needles) }))
    .sort((left, right) => right.score - left.score);
  if (ranked[0]!.score === 0 || ranked[0]!.score === ranked[1]!.score) {
    if (allowRepresentativeItem && schema.type === "object" && needles.length === 0)
      return candidates[0];
    throw new PrerequisiteBindingError(
      "Prerequisite output binding is ambiguous; refusing to guess",
    );
  }
  return ranked[0]!.candidate;
}

function nestedValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return [value, ...value.flatMap(nestedValues)];
  if (value === null || typeof value !== "object") return [value];
  return [value, ...Object.values(value).flatMap(nestedValues)];
}

function semanticCandidateScore(candidate: unknown, needles: string[]): number {
  const haystacks = nestedValues(candidate)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return needles.reduce(
    (best, needle) =>
      Math.max(best, haystacks.some((value) => value.includes(needle)) ? needle.length : 0),
    0,
  );
}

async function bootstrapSafeSearch(input: {
  tools: {
    exploreFill(args: { locator: LocatorDefinition; value: string }): Promise<unknown>;
    exploreClick(args: { locator: LocatorDefinition }): Promise<unknown>;
  };
  overview: unknown;
  expectedActionName?: string;
  taskInputs: Record<string, unknown>;
  allowedSafety?: StepSafety[];
  beforeAction(): Promise<void>;
  onValidated(locator: LocatorDefinition): void;
}): Promise<boolean> {
  if (!input.expectedActionName?.toLowerCase().startsWith("search")) return false;
  if (input.allowedSafety !== undefined && !input.allowedSafety.includes("browser-local")) {
    return false;
  }
  const query = input.taskInputs.query;
  if (typeof query !== "string") return false;
  const forms = asRecordArray(asRecord(input.overview)?.forms);
  const candidates = forms.flatMap((form) => {
    const fields = asRecordArray(form.fields);
    const textboxes = fields.filter((field) => field.role === "textbox");
    const buttons = fields.filter(
      (field) => field.role === "button" && typeof field.name === "string",
    );
    if (textboxes.length !== 1 || buttons.length !== 1) return [];
    const label = textboxes[0]!.label ?? textboxes[0]!.name;
    if (typeof label !== "string") return [];
    return [{ label, button: buttons[0]!.name as string }];
  });
  if (candidates.length !== 1) return false;
  await input.beforeAction();
  const fillLocator: LocatorDefinition = { strategy: "label", label: candidates[0]!.label };
  const fill = await input.tools.exploreFill({
    locator: fillLocator,
    value: query,
  });
  if (isSuccessfulExploreResult(fill)) input.onValidated(fillLocator);
  const clickLocator: LocatorDefinition = {
    strategy: "role",
    role: "button",
    name: candidates[0]!.button,
  };
  const click = await input.tools.exploreClick({
    locator: clickLocator,
  });
  if (isSuccessfulExploreResult(click)) input.onValidated(clickLocator);
  return isSuccessfulExploreResult(fill) && isSuccessfulExploreResult(click);
}

function isSuccessfulExploreResult(value: unknown): boolean {
  return asRecord(value)?.ok === true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        return record === undefined ? [] : [record];
      })
    : [];
}

export async function runActionDiscoveryCode(
  input: Parameters<typeof registerActionDiscoveryTools>[1],
  code: string,
): Promise<{ value: unknown; runCodeExecutions: number; nestedToolCalls: number }> {
  const harness = new Context();
  let nestedToolCalls = 0;
  try {
    await harness.plugin(SystemPrompt);
    await harness.plugin(ToolRuntime, { mode: "code", maxParallelSubCalls: 1 });
    await harness.plugin(WorkerThreadCodeRuntime, {});
    await registerActionDiscoveryTools(harness, input);
    harness.on("tools/result", (execution) => {
      if (execution.name !== RUN_CODE_NAME) nestedToolCalls += 1;
    });
    const result = await harness.tools.execute({
      callId: CallId("action-discovery-code-1"),
      name: RUN_CODE_NAME,
      arguments: {
        code,
        description: "Explore a page, build one site action, and validate it",
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

type LocatorInput = {
  strategy: "role" | "text" | "label" | "test-id" | "css";
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  testId?: string;
  selector?: string;
  exact?: boolean;
  bindings?: LocatorDefinition["bindings"];
  attribute?: LocatorDefinition["attribute"];
  within?: {
    kind: "form" | "landmark" | "container";
    name?: string;
    role?: string;
    locator?: LocatorDefinition;
  };
};

function toLocator(input: LocatorInput): LocatorDefinition {
  const within = toScope(input.within);
  const options = {
    ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
    ...(input.attribute === undefined ? {} : { attribute: input.attribute }),
    ...(input.exact === undefined ? {} : { exact: input.exact }),
    ...(within === undefined ? {} : { within }),
  };
  switch (input.strategy) {
    case "role":
      if (input.role === undefined) throw new Error("role locator requires role");
      return {
        strategy: "role",
        role: input.role,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...options,
      };
    case "text":
      if (input.text === undefined) throw new Error("text locator requires text");
      return { strategy: "text", text: input.text, ...options };
    case "label":
      if (input.label === undefined) throw new Error("label locator requires label");
      return { strategy: "label", label: input.label, ...options };
    case "test-id":
      if (input.testId === undefined) throw new Error("test-id locator requires testId");
      return {
        strategy: "test-id",
        testId: input.testId,
        ...options,
      };
    case "css":
      if (input.selector === undefined) throw new Error("css locator requires selector");
      return {
        strategy: "css",
        selector: input.selector,
        ...options,
      };
  }
}

function toScope(input: LocatorInput["within"]) {
  if (input?.kind === "container") {
    if (!input.locator) throw new Error("Container requires a locator");
    return { kind: "container" as const, locator: input.locator };
  }
  if (input === undefined) return undefined;
  if (input.kind === "form") {
    if (input.name === undefined || input.name.length === 0) {
      throw new Error("form scope requires name");
    }
    return { kind: "form" as const, name: input.name };
  }
  if (input.role === undefined || input.role.length === 0) {
    throw new Error("landmark scope requires role");
  }
  return input.name === undefined
    ? { kind: "landmark" as const, role: input.role }
    : { kind: "landmark" as const, role: input.role, name: input.name };
}

type ActionStepInput = {
  id: string;
  type: "navigate" | "fill" | "select" | "click" | "extract-text" | "extract-list";
  safety?: StepSafety;
  url?: string;
  value?: string;
  valueKind?: "literal" | "input";
  valueKey?: string;
  output?: string;
  locator?: LocatorInput;
  fields?: ListFieldInput[];
  ready?: unknown;
  completion?: unknown;
  empty?: unknown;
};

type ListFieldInput = {
  optional?: boolean;
  key: string;
  source: "text" | "attr" | "url";
  name?: string;
  locator?: LocatorInput;
};

type ScalarContractFieldInput = {
  format?: "decimal-point" | "decimal-comma" | "currency-decimal-point" | "currency-decimal-comma";
  key: string;
  type: "string" | "number" | "boolean";
  optional?: boolean;
  description?: string;
};

type ContractFieldInput =
  | ScalarContractFieldInput
  | {
      key: string;
      type: "object" | "array-object";
      optional?: boolean;
      description?: string;
      properties: ScalarContractFieldInput[];
    };

function normalizeDiscoveryCondition(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const condition = value as Record<string, unknown>;
  if ((condition.kind === "all" || condition.kind === "any") && Array.isArray(condition.conditions))
    return { ...condition, conditions: condition.conditions.map(normalizeDiscoveryCondition) };
  if (
    condition.kind === "changed" &&
    (condition.attribute === "innerText" || condition.attribute === "textContent")
  ) {
    const { attribute: _attribute, ...textChange } = condition;
    return textChange;
  }
  return condition;
}

function containsChangedCondition(condition: Condition | undefined): boolean {
  if (!condition) return false;
  if (condition.kind === "all" || condition.kind === "any")
    return condition.conditions.some(containsChangedCondition);
  return condition.kind === "changed";
}

function parseCondition(value: unknown): Condition {
  const condition = normalizeDiscoveryCondition(
    typeof value === "string" ? JSON.parse(value) : value,
  ) as Condition;
  try {
    validateCondition(condition);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Conditions require a kind discriminator, for example {"kind":"visible","locator":{...},"value":true} or {"kind":"attribute","locator":{...},"name":"aria-selected","value":"true"}. Correct the declaration without repeating successful exploration.`,
    );
  }
  return condition;
}
function toActionStep(input: ActionStepInput): Step {
  const step = toActionStepBase(input);
  return {
    ...step,
    ...(input.ready === undefined ? {} : { ready: parseCondition(input.ready) }),
    ...(input.completion === undefined ? {} : { completion: parseCondition(input.completion) }),
    ...(step.type === "extract-list" && input.empty !== undefined
      ? { empty: parseCondition(input.empty) }
      : {}),
  };
}
function toActionStepBase(input: ActionStepInput): Step {
  const safety =
    input.safety ??
    (input.type === "extract-text" || input.type === "extract-list"
      ? "read-only"
      : "browser-local");
  if (input.type === "navigate") {
    if (input.valueKind === "input") {
      return { id: input.id, type: "navigate", safety, url: toValue(input) };
    }
    if (input.url === undefined) throw new Error("navigate step requires url or input valueKey");
    return { id: input.id, type: "navigate", safety, url: { kind: "literal", value: input.url } };
  }
  if (input.locator === undefined) throw new Error(`${input.type} step requires locator`);
  const locator = toLocator(input.locator);
  if (input.type === "extract-text") {
    if (input.output === undefined || input.output.length === 0) {
      throw new Error("extract-text step requires output");
    }
    return { id: input.id, type: "extract-text", safety, locator, output: input.output };
  }
  if (input.type === "extract-list") {
    if (input.output === undefined || input.output.length === 0) {
      throw new Error("extract-list step requires output");
    }
    if (input.fields === undefined) throw new Error("extract-list step requires fields");
    return {
      id: input.id,
      type: "extract-list",
      safety,
      locator,
      output: input.output,
      fields: toListFields(input.fields),
    };
  }
  if (input.type === "click") {
    return { id: input.id, type: "click", safety, locator };
  }
  return {
    id: input.id,
    type: input.type,
    safety,
    locator,
    value: toValue(input),
  };
}

function toListFields(fields: ListFieldInput[]): Record<string, ListField> {
  const next: Record<string, ListField> = {};
  for (const field of fields) {
    const key = field.key.trim();
    if (key.length === 0) throw new Error("extract-list field key is required");
    if (next[key] !== undefined) throw new Error(`duplicate extract-list field ${key}`);
    if (field.source === "text") {
      next[key] = {
        source: "text",
        ...(field.locator === undefined ? {} : { locator: toLocator(field.locator) }),
        ...(field.optional === undefined ? {} : { optional: field.optional }),
      };
      continue;
    }
    if (field.name === undefined || field.name.length === 0) {
      throw new Error(`extract-list field ${key} needs an attribute name`);
    }
    next[key] =
      field.locator === undefined
        ? { source: field.source, name: field.name }
        : { source: field.source, name: field.name, locator: toLocator(field.locator) };
  }
  for (const field of fields)
    if (field.optional !== undefined) next[field.key.trim()]!.optional = field.optional;
  return next;
}

function toActionSchema(fields: ContractFieldInput[]): ActionSchema {
  const schema: ActionSchema = {};
  for (const field of fields) {
    const key = field.key.trim();
    if (key.length === 0) throw new Error("action contract field key is required");
    if (schema[key] !== undefined) throw new Error(`duplicate action contract field ${key}`);
    const optional = field.optional === true ? { optional: true as const } : {};
    if (field.type === "object" || field.type === "array-object") {
      const properties = toActionSchema(field.properties);
      schema[key] =
        field.type === "object"
          ? { type: "object", properties, ...optional }
          : { type: "array", items: { type: "object", properties }, ...optional };
      continue;
    }
    schema[key] = {
      type: field.type,
      ...optional,
      ...(field.type === "number" && field.format !== undefined ? { format: field.format } : {}),
    };
  }
  return schema;
}

function toValue(input: {
  value?: string;
  valueKind?: "literal" | "input";
  valueKey?: string;
}): FillValue {
  if (input.valueKind === "input") {
    if (input.valueKey === undefined) throw new Error("input value requires valueKey");
    return { kind: "input", key: input.valueKey };
  }
  if (input.valueKind === "literal") {
    if (input.value === undefined) throw new Error("literal value requires value");
    return { kind: "literal", value: input.value };
  }
  if (input.value === undefined) throw new Error("fill/select step requires value");
  return input.value;
}

function findExistingStepOwner(actions: SiteActionDefinition[], step: Step): string | undefined {
  const key = reusableStepKey(step);
  return actions.find((action) =>
    action.implementation.steps.some((existing) => reusableStepKey(existing) === key),
  )?.name;
}

function reusableStepKey(step: Step): string {
  const { id: _id, safety: _safety, ...behavior } = step;
  return JSON.stringify(behavior);
}

function locatorKey(locator: LocatorDefinition): string {
  return JSON.stringify(locator);
}

function listStepKey(locator: LocatorDefinition, fields: Record<string, ListField>): string {
  return JSON.stringify({ locator, fields });
}

function assertReusableTextExtraction(step: Step, previewedText: Map<string, string>): void {
  if (step.type !== "extract-text") return;
  const observed = previewedText.get(locatorKey(step.locator));
  if (observed === undefined) {
    throw new Error(
      "Extraction was not previewed. Call readText with the exact locator before submitAction",
    );
  }
  if (step.locator.strategy === "text") {
    throw new Error(
      "Extract-text locators cannot select by the text being returned; use an unnamed role, test id, or scoped CSS locator",
    );
  }
  if (step.locator.strategy !== "role" || step.locator.name === undefined) return;
  const name = normalizeVisibleText(step.locator.name);
  const output = normalizeVisibleText(observed);
  const pinsOutput = step.locator.exact === true ? name === output : output.includes(name);
  if (pinsOutput) {
    throw new Error(
      "Extract-text role locators cannot copy the observed output into name; identify the element structurally instead",
    );
  }
}

function normalizeVisibleText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function assertStepWasValidated(
  step: Step,
  validatedLocators: Set<string>,
  validatedLists: Set<string>,
): void {
  if (step.type === "navigate") return;
  if (step.type === "extract-list") {
    if (validatedLists.has(listStepKey(step.locator, step.fields))) return;
    throw new Error(
      `Step ${step.id} extraction was not successfully validated. Call previewList with its exact locator and fields before saving it`,
    );
  }
  if (validatedLocators.has(locatorKey(step.locator))) return;
  throw new Error(
    `Step ${step.id}: Locator was not successfully validated: ${JSON.stringify(step.locator)}. Call testLocator and use a unique, visible, enabled locator before saving it`,
  );
}

async function assertConditionCardinality(
  page: import("playwright").Page,
  condition: Condition | undefined,
): Promise<void> {
  if (!condition) return;
  if (condition.kind === "all" || condition.kind === "any") {
    for (const child of condition.conditions) await assertConditionCardinality(page, child);
    return;
  }
  if (condition.kind === "count" || !("locator" in condition)) return;
  // Parameterized targets need representative inputs; a different page may also
  // legitimately have no matches before or after the action's state transition.
  if (inputReferences(condition.locator).length > 0) return;
  const count = await resolveLocator(page, condition.locator).count();
  if (count > 1) {
    throw new Error(
      `${condition.kind} condition requires a unique locator, but matched ${count} elements. Use a scoped locator for one element, or a count condition with comparison gte for a repeated list.`,
    );
  }
}

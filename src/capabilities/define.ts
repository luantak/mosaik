import type { AutomationContext } from "../library/automations-api.js";
import { validateCondition, validateReferences } from "./contracts.js";
import { compile, CompileError, type Step, type StepSafety } from "../core/index.js";
import { validateSchemaMap, type InferActionSchema } from "./schema.js";
import { normalizeSiteId } from "./site.js";
import type { ActionSchema, SiteActionDefinition } from "./types.js";

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFETY_RANK: Record<StepSafety, number> = {
  "read-only": 0,
  "browser-local": 1,
  "external-side-effect": 2,
};

export function defineAction<
  const TInputs extends ActionSchema = Record<string, never>,
  const TOutputs extends ActionSchema = Record<string, never>,
>(input: {
  id: string;
  siteId: string;
  name: string;
  description: string;
  aliases?: string[];
  contexts?: string[];
  inputs?: TInputs;
  outputs?: TOutputs;
  safety: StepSafety;
  steps: Step[];
  implementationId?: string;
  precondition?: import("../core/types.js").Condition;
  completion?: import("../core/types.js").Condition;
  conditionTimeoutMs?: number;
  implementations?: SiteActionDefinition["implementations"];
  contractVersion?: number;
  version?: number;
  interfaceVersion?: number;
  verification?: SiteActionDefinition["verification"];
}): CallableSiteAction<InferActionSchema<TInputs>, InferActionSchema<TOutputs>> {
  return compileSiteAction({
    id: input.id,
    siteId: input.siteId,
    name: input.name,
    description: input.description,
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
    ...(input.contexts === undefined ? {} : { contexts: input.contexts }),
    inputs: input.inputs ?? {},
    outputs: input.outputs ?? {},
    implementation: {
      steps: input.steps,
      ...(input.implementationId === undefined ? {} : { id: input.implementationId }),
      ...(input.precondition === undefined ? {} : { precondition: input.precondition }),
      ...(input.completion === undefined ? {} : { completion: input.completion }),
      ...(input.conditionTimeoutMs === undefined
        ? {}
        : { conditionTimeoutMs: input.conditionTimeoutMs }),
    },
    ...(input.implementations === undefined ? {} : { implementations: input.implementations }),
    ...(input.contractVersion === undefined ? {} : { contractVersion: input.contractVersion }),
    safety: input.safety,
    version: input.version ?? 1,
    interfaceVersion: input.interfaceVersion ?? 1,
    verification: input.verification ?? "unverified",
  }) as CallableSiteAction<InferActionSchema<TInputs>, InferActionSchema<TOutputs>>;
}

/** Site action definition that is also callable from automation TypeScript. */
export type CallableSiteAction<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
> = SiteActionDefinition & {
  (args?: TInput): Promise<TOutput>;
  (ctx: AutomationContext, args: TInput): Promise<TOutput>;
};

export function compileSiteAction(action: SiteActionDefinition): SiteActionDefinition {
  if (action.id.length === 0) throw new CompileError("Action id is required");
  if (action.name.length === 0) throw new CompileError("Action name is required");
  if (!NAME_PATTERN.test(action.name)) {
    throw new CompileError(`Action name is not a valid identifier: ${action.name}`);
  }
  if (action.description.trim().length === 0) {
    throw new CompileError("Action description is required");
  }
  const aliases = normalizeAliases(action.aliases);
  const contexts = normalizeContexts(action.contexts);

  const siteId = normalizeSiteId(action.siteId);
  compile({
    id: action.id,
    version: action.version,
    actions: [
      {
        id: action.id,
        name: action.name,
        steps: action.implementation.steps,
      },
    ],
  });
  validateSchemaMap("inputs", action.inputs);
  validateSchemaMap("outputs", action.outputs);

  const stepSafety = strongestSafety(action.implementation.steps);
  if (SAFETY_RANK[action.safety] < SAFETY_RANK[stepSafety]) {
    throw new CompileError(
      `Action safety ${action.safety} is weaker than step safety ${stepSafety}`,
    );
  }

  for (const step of action.implementation.steps) {
    if (
      (step.type === "extract-text" || step.type === "extract-list") &&
      action.outputs[step.output] === undefined
    ) {
      throw new CompileError(
        `${step.type} output ${step.output} is not in the action outputs schema`,
      );
    }
  }

  const implementations = action.implementations ?? [action.implementation];
  if (implementations.length < 1 || implementations.length > 8)
    throw new CompileError("Actions require 1 to 8 implementations");
  const ids = new Set<string>();
  for (const implementation of implementations) {
    if (action.implementations) {
      if (
        !implementation.id ||
        ids.has(implementation.id) ||
        !implementation.precondition ||
        !implementation.completion
      )
        throw new CompileError(
          "State implementations require unique IDs, preconditions and completion conditions",
        );
      ids.add(implementation.id);
    }
    compile({
      id: action.id,
      version: action.version,
      actions: [{ id: action.id, name: action.name, steps: implementation.steps }],
    });
    if (SAFETY_RANK[action.safety] < SAFETY_RANK[strongestSafety(implementation.steps)])
      throw new CompileError("Implementation exceeds action safety");
    validateReferences(implementation, action.inputs);
    validateCondition(implementation.precondition);
    validateCondition(implementation.completion);
    for (const step of implementation.steps) {
      validateCondition(step.ready);
      validateCondition(step.completion);
      if (step.type === "extract-list") validateCondition(step.empty);
      if (
        (step.type === "extract-list" || step.type === "extract-text") &&
        !action.outputs[step.output]
      )
        throw new CompileError(`Unknown output ${step.output}`);
    }
  }
  const next: SiteActionDefinition = {
    id: action.id,
    siteId,
    name: action.name,
    description: action.description,
    inputs: structuredClone(action.inputs),
    outputs: structuredClone(action.outputs),
    implementation: structuredClone(action.implementation),
    ...(action.implementations === undefined
      ? {}
      : { implementations: structuredClone(action.implementations) }),
    ...(action.contractVersion === undefined ? {} : { contractVersion: action.contractVersion }),
    ...(action.verificationBasis === undefined
      ? {}
      : { verificationBasis: action.verificationBasis }),
    safety: action.safety,
    version: action.version,
    interfaceVersion: (action.interfaceVersion ?? 0) > 0 ? action.interfaceVersion : 1,
    verification: action.verification,
  };
  if (action.runStats !== undefined) next.runStats = structuredClone(action.runStats);
  if (action.versionHistory !== undefined) {
    next.versionHistory = structuredClone(action.versionHistory);
  }
  if (aliases !== undefined) next.aliases = aliases;
  if (contexts !== undefined) next.contexts = contexts;
  return next;
}

function normalizeAliases(aliases: string[] | undefined): string[] | undefined {
  if (aliases === undefined) return undefined;
  const seen = new Set<string>();
  const next: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (trimmed.length === 0) throw new CompileError("Action aliases must be non-empty");
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(trimmed);
  }
  return next.length === 0 ? undefined : next;
}

function normalizeContexts(contexts: string[] | undefined): string[] | undefined {
  if (contexts === undefined) return undefined;
  const seen = new Set<string>();
  const next: string[] = [];
  for (const context of contexts) {
    const trimmed = context.trim();
    if (trimmed.length === 0) throw new CompileError("Action contexts must be non-empty");
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(trimmed);
  }
  return next.length === 0 ? undefined : next;
}

function strongestSafety(steps: Step[]): StepSafety {
  let strongest: StepSafety = "read-only";
  for (const step of steps) {
    if (SAFETY_RANK[step.safety] > SAFETY_RANK[strongest]) strongest = step.safety;
  }
  return strongest;
}

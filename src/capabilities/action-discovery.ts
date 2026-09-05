import { type Condition, type Step, type StepSafety, type FillValue } from "../core/index.js";
import { inputReferences } from "./contracts.js";
import { compileSiteAction, defineAction } from "./define.js";
import { assertSiteCapability } from "./granularity.js";
import { toSummary, type SiteActionRegistry } from "./lookup.js";
import { validateSchemaMap } from "./schema.js";
import { normalizeSiteId } from "./site.js";
import type { ActionSchema, SiteActionSummary } from "./types.js";
import { unwrapCodeModeValue } from "./code-mode.js";

export interface ActionDiscoveryDraft {
  siteId: string;
  id?: string;
  name?: string;
  description?: string;
  aliases?: string[];
  contexts?: string[];
  inputs: ActionSchema;
  outputs: ActionSchema;
  safety?: StepSafety;
  steps: Step[];
  precondition?: Condition;
  completion?: Condition;
}

export interface ActionDiscoverySession {
  preview(): { draft: ActionDiscoveryDraft };
  submit(
    candidate: Omit<ActionDiscoveryDraft, "siteId">,
  ): Promise<{ status: "discovered"; action: SiteActionSummary }>;
}

export interface TerminalActionDiscovery {
  observedPage?: { url: string; title: string };
  status: "discovered";
  action: SiteActionSummary;
}

export function createActionDiscoverySession(input: {
  registry: SiteActionRegistry;
  siteId: string;
  allowedSafety?: StepSafety[];
}): ActionDiscoverySession {
  const siteId = normalizeSiteId(input.siteId);
  let draft: ActionDiscoveryDraft = {
    siteId,
    inputs: {},
    outputs: {},
    steps: [],
  };

  return {
    async submit(candidate) {
      const next = structuredClone({ siteId, ...candidate });
      validateSchemaMap("inputs", next.inputs);
      validateSchemaMap("outputs", next.outputs);
      const created = await saveCandidate(next, input);
      draft = next;
      return { status: "discovered", action: toSummary(created) };
    },
    preview() {
      return { draft: snapshotDraft(draft) };
    },
  };
}

async function saveCandidate(
  draft: ActionDiscoveryDraft,
  input: Parameters<typeof createActionDiscoverySession>[0],
) {
  const { name, description, safety } = draft;
  if (!name) throw new Error("Site action name is required");
  if (!description?.trim()) throw new Error("Site action description is required");
  if (!safety) throw new Error("Site action safety is required");
  if (input.allowedSafety !== undefined && !input.allowedSafety.includes(safety)) {
    throw new Error(`Site action safety ${safety} is outside the discovery policy`);
  }
  if (draft.steps.length === 0) throw new Error("Site action needs at least one step");
  const referencedInputs = new Set(inputReferences(draft));
  for (const key of Object.keys(draft.inputs)) {
    if (![...referencedInputs].some((reference) => reference.split(".")[0] === key)) {
      throw new Error(`Site action input ${key} is not used by any compiled step`);
    }
  }
  assertNavigationConditions(draft.steps, draft.precondition);
  assertExtractionCompletion(draft.steps, draft.completion);
  assertExtractedOutputFields(draft);
  assertSiteCapability({ name, description });
  const created = compileSiteAction(
    defineAction({
      id: draft.id ?? defaultActionId(draft.siteId, name),
      siteId: draft.siteId,
      name,
      description,
      ...(draft.aliases === undefined ? {} : { aliases: draft.aliases }),
      ...(draft.contexts === undefined ? {} : { contexts: draft.contexts }),
      inputs: draft.inputs,
      outputs: draft.outputs,
      safety,
      steps: draft.steps,
      ...(draft.precondition === undefined ? {} : { precondition: draft.precondition }),
      ...(draft.completion === undefined ? {} : { completion: draft.completion }),
    }),
  );
  await input.registry.save(created);
  return created;
}

function assertExtractedOutputFields(draft: ActionDiscoveryDraft): void {
  const producedOutputs = new Set(
    draft.steps.flatMap((step) =>
      step.type === "extract-text" || step.type === "extract-list" ? [step.output] : [],
    ),
  );
  for (const output of Object.keys(draft.outputs)) {
    if (!producedOutputs.has(output)) {
      throw new Error(`Action output ${output} has no compiled extraction step`);
    }
  }
  for (const step of draft.steps) {
    if (step.type !== "extract-list") continue;
    const output = draft.outputs[step.output];
    if (output?.type !== "array" || output.items.type !== "object") {
      throw new Error(
        `Extract-list output ${step.output} must declare an array of objects, even for one row. Read a single field from that array in the automation.`,
      );
    }
    for (const key of Object.keys(output.items.properties)) {
      if (step.fields[key] === undefined) {
        throw new Error(`Extract-list output ${step.output}.${key} has no compiled field`);
      }
    }
  }
}

export function defaultActionId(siteId: string, name: string): string {
  const host = normalizeSiteId(siteId);
  const leaf = host.split(".")[0] ?? host;
  const kebab = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return `${leaf}.${kebab}`;
}

export function parseTerminalActionDiscovery(value: unknown): TerminalActionDiscovery {
  const raw = unwrapCodeModeValue(value);
  if (raw === null || typeof raw !== "object") {
    throw new Error("Action discovery Code Mode result is missing");
  }
  const record = raw as Record<string, unknown>;
  if (record.status !== "discovered") {
    throw new Error("Action discovery Code Mode result must have status discovered");
  }
  const action = record.action;
  if (action === null || typeof action !== "object") {
    throw new Error("Action discovery Code Mode result is missing action");
  }
  const body = action as Record<string, unknown>;
  if (typeof body.source === "string" || typeof body.run_code === "string") {
    throw new Error("Code Mode is not a site action; save a compiled capability");
  }
  if (
    typeof body.id !== "string" ||
    typeof body.siteId !== "string" ||
    typeof body.name !== "string"
  ) {
    throw new Error("Action discovery Code Mode action is incomplete");
  }
  if (typeof body.description !== "string" || typeof body.signature !== "string") {
    throw new Error("Action discovery Code Mode action is incomplete");
  }
  if (
    body.safety !== "read-only" &&
    body.safety !== "browser-local" &&
    body.safety !== "external-side-effect"
  ) {
    throw new Error("Action discovery Code Mode action is missing safety");
  }
  return {
    status: "discovered",
    ...(record.observedPage &&
    typeof record.observedPage === "object" &&
    typeof (record.observedPage as Record<string, unknown>).url === "string" &&
    typeof (record.observedPage as Record<string, unknown>).title === "string"
      ? { observedPage: record.observedPage as { url: string; title: string } }
      : {}),
    action: {
      id: body.id,
      siteId: body.siteId,
      name: body.name,
      description: body.description,
      signature: body.signature,
      inputs: asSchema(body.inputs, "inputs"),
      outputs: asSchema(body.outputs, "outputs"),
      safety: body.safety,
      version: typeof body.version === "number" ? body.version : 1,
      interfaceVersion: typeof body.interfaceVersion === "number" ? body.interfaceVersion : 1,
      verification:
        body.verification === "verified" || body.verification === "invalid"
          ? body.verification
          : "unverified",
      ...(Array.isArray(body.aliases)
        ? { aliases: body.aliases.filter((alias): alias is string => typeof alias === "string") }
        : {}),
    },
  };
}

function asSchema(value: unknown, label: string): ActionSchema {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const schema = value as ActionSchema;
  validateSchemaMap(label, schema);
  return structuredClone(schema);
}

function snapshotDraft(draft: ActionDiscoveryDraft): ActionDiscoveryDraft {
  return {
    siteId: draft.siteId,
    inputs: structuredClone(draft.inputs),
    outputs: structuredClone(draft.outputs),
    steps: structuredClone(draft.steps),
    ...(draft.precondition === undefined
      ? {}
      : { precondition: structuredClone(draft.precondition) }),
    ...(draft.completion === undefined ? {} : { completion: structuredClone(draft.completion) }),
    ...(draft.id === undefined ? {} : { id: draft.id }),
    ...(draft.name === undefined ? {} : { name: draft.name }),
    ...(draft.description === undefined ? {} : { description: draft.description }),
    ...(draft.aliases === undefined ? {} : { aliases: [...draft.aliases] }),
    ...(draft.safety === undefined ? {} : { safety: draft.safety }),
  };
}

function assertNavigationConditions(steps: Step[], precondition: Condition | undefined): void {
  const first = steps[0];
  if (first?.type === "navigate" && requiresDestination(precondition, first.url)) {
    throw new Error(
      "A navigation destination is a completion condition, not a precondition. Omit the precondition or clear it with null; it is checked before navigation.",
    );
  }
  for (const step of steps) {
    if (step.type === "navigate" && requiresDestination(step.ready, step.url)) {
      throw new Error(
        "A navigation destination is a completion condition, not readiness. Move the destination URL condition from ready to completion; ready is checked before navigation.",
      );
    }
  }
}

function requiresDestination(condition: Condition | undefined, destination: FillValue): boolean {
  if (!condition) return false;
  if (condition.kind === "all")
    return condition.conditions.some((child) => requiresDestination(child, destination));
  if (condition.kind === "any")
    return (
      condition.conditions.length > 0 &&
      condition.conditions.every((child) => requiresDestination(child, destination))
    );
  if (condition.kind !== "url" || (condition.comparison ?? "equals") !== "equals") return false;
  const normalized = (value: FillValue) =>
    typeof value === "string" ? { kind: "literal", value } : value;
  return JSON.stringify(normalized(condition.value)) === JSON.stringify(normalized(destination));
}

function assertExtractionCompletion(steps: Step[], completion: Condition | undefined): void {
  const extraction = (step: Step) => step.type === "extract-text" || step.type === "extract-list";
  if (
    steps.some((step) => extraction(step) && requiresChange(step.completion)) ||
    (steps.length > 0 && steps.every(extraction) && requiresChange(completion))
  ) {
    throw new Error(
      "Extraction reads the page without changing it. Omit the changed completion condition or use a stable visibility/count condition.",
    );
  }
}

function requiresChange(condition: Condition | undefined): boolean {
  if (!condition) return false;
  if (condition.kind === "all") return condition.conditions.some(requiresChange);
  if (condition.kind === "any")
    return condition.conditions.length > 0 && condition.conditions.every(requiresChange);
  return condition.kind === "changed";
}

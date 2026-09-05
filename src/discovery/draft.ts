import { compile, findStep, type Automation, type Step } from "../core/index.js";
import type { DiscoveryConstraints, DiscoveryRequest } from "./types.js";

export function emptyDraft(request: DiscoveryRequest): Automation {
  return {
    id: request.id,
    version: 1,
    verification: { status: "unverified" },
    actions: [
      {
        id: `${request.id}/main`,
        name: request.id,
        steps: [],
      },
    ],
  };
}

export function draftSteps(draft: Automation): Step[] {
  const action = draft.actions[0];
  if (action === undefined) throw new Error("Discovery draft has no action");
  return action.steps;
}

export function addDraftStep(
  draft: Automation,
  step: Step,
  constraints: DiscoveryConstraints,
  beforeStepId?: string,
): Automation {
  assertAllowedStep(step, constraints);
  const action = draft.actions[0];
  if (action === undefined) throw new Error("Discovery draft has no action");
  if (action.steps.length >= constraints.maxSteps) {
    throw new Error(`maxSteps exceeded (${constraints.maxSteps})`);
  }
  if (action.steps.some((entry) => entry.id === step.id)) {
    throw new Error(`Duplicate step id: ${step.id}`);
  }
  const insertAt =
    beforeStepId === undefined ? action.steps.length : findStep(draft, beforeStepId).index;
  const steps = [...action.steps.slice(0, insertAt), step, ...action.steps.slice(insertAt)];
  return compiledDraft({
    ...draft,
    actions: [{ ...action, steps }],
  });
}

export function updateDraftStep(
  draft: Automation,
  step: Step,
  constraints: DiscoveryConstraints,
): Automation {
  assertAllowedStep(step, constraints);
  const found = findStep(draft, step.id);
  const action = found.action;
  const steps = action.steps.map((entry, index) => (index === found.index ? step : entry));
  return compiledDraft({
    ...draft,
    actions: draft.actions.map((entry) => (entry.id === action.id ? { ...entry, steps } : entry)),
  });
}

export function removeDraftStep(draft: Automation, stepId: string): Automation {
  const found = findStep(draft, stepId);
  const steps = found.action.steps.filter((step) => step.id !== stepId);
  const next: Automation = {
    ...draft,
    actions: draft.actions.map((entry) =>
      entry.id === found.action.id ? { ...entry, steps } : entry,
    ),
  };
  return steps.length === 0 ? next : compiledDraft(next);
}

function assertAllowedStep(step: Step, constraints: DiscoveryConstraints): void {
  if (!constraints.allowedStepTypes.includes(step.type)) {
    throw new Error(`Step type ${step.type} is not allowed`);
  }
  if (step.safety === "external-side-effect" && !constraints.allowExternalSideEffects) {
    throw new Error("external-side-effect steps are not allowed");
  }
}

function compiledDraft(draft: Automation): Automation {
  const compiled = compile(draft);
  return {
    ...compiled,
    verification: draft.verification ?? { status: "unverified" },
  };
}

import {
  beginCase,
  captureStep,
  captureStructure,
  finishCase,
  fingerprint,
  redactValue,
} from "../evidence/capture.js";
import type { ActionCaseStore } from "../evidence/types.js";
import type { Page } from "playwright";
import { coerceValue, validateObject, type SiteActionDefinition } from "../capabilities/index.js";
import { resolveStepValue, type AutomationFailure, type Step } from "../core/index.js";
import { DEFAULT_STEP_TIMEOUT_MS, executeStep } from "../runtime/execute.js";
import { bindLocator } from "../runtime/locators.js";
import { inputReferences } from "../capabilities/contracts.js";
import { captureBefore, observeCondition, waitCondition } from "../runtime/conditions.js";
import type { ActionCheckpoint } from "./checkpoint.js";
import type { ActionImplementation } from "../capabilities/types.js";
import { HostActionError, type ActionHost } from "./types.js";

export function createPlaywrightHost(
  page: Page,
  actions: SiteActionDefinition[],
  options: {
    timeoutMs?: number;
    runId?: string;
    cases?: ActionCaseStore;
    onEvidenceError?: (message: string) => void;
    haltBefore?: (step: Step) => boolean;
    repair?: (checkpoint: ActionCheckpoint) => Promise<SiteActionDefinition | undefined>;
    onSuccess?: (
      action: SiteActionDefinition,
      input: Record<string, unknown>,
      output: Record<string, unknown>,
      implementation: ActionImplementation,
    ) => Promise<void>;
  } = {},
): ActionHost {
  const byName = new Map(actions.map((action) => [action.name, action]));
  const timeoutMs = options.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const runId = options.runId ?? "automation";

  return {
    async invoke(name, args) {
      let action = byName.get(name);
      if (action === undefined) throw new HostActionError(`Unknown action: ${name}`);
      const input = validateObject(action.inputs, args ?? {}, name);
      const extracted: Record<string, unknown> = {};
      for (const key of inputReferences(action.implementations ?? action.implementation))
        resolveStepValue({ kind: "input", key }, input);
      let candidates = action.implementations ?? [action.implementation];
      const matches = [];
      for (const candidate of candidates) {
        if (
          !candidate.precondition ||
          (await observeCondition(page, candidate.precondition, input))
        )
          matches.push(candidate);
      }
      if (matches.length === 0 && options.repair) {
        const failed = candidates[0]!;
        const failure = await toFailure(page, runId, action, failed.steps[0]!, {
          type: "unsupported-state",
          message: "No implementation recognizes the current state",
        });
        const next = await options.repair({
          action,
          implementation: failed,
          inputs: input,
          context: { tab: "active", frame: "main" },
          completedSteps: [],
          failedStepIndex: 0,
          outputs: extracted,
          before: new Map(),
          page,
          failure,
        });
        if (next) {
          action = next;
          candidates = next.implementations ?? [next.implementation];
          for (const candidate of candidates)
            if (
              !candidate.precondition ||
              (await observeCondition(page, candidate.precondition, input))
            )
              matches.push(candidate);
        }
      }
      if (matches.length !== 1) {
        const type = matches.length === 0 ? "unsupported-state" : "ambiguous-state";
        throw new HostActionError(
          type,
          await toFailure(page, runId, action, candidates[0]!.steps[0]!, { type, message: type }),
        );
      }
      let implementation = matches[0]!;
      const completedSteps: string[] = [];
      const attempted = new Set<string>();
      const before = await captureBefore(page, implementation.completion, input);
      const actionCase = options.cases
        ? await beginCase(page, action, implementation, input, runId)
        : undefined;
      for (const step of implementation.steps) {
        if ("locator" in step) bindLocator(step.locator, input);
      }

      for (let index = 0; index < implementation.steps.length; index += 1) {
        const step = extractionOptionality(implementation.steps[index]!, action);
        if (options.haltBefore?.(step) === true) {
          throw new HostActionError(`Halted before ${step.id} (${step.safety})`, undefined, true);
        }
        if (actionCase) {
          actionCase.steps = actionCase.steps.filter((entry) => entry.stepId !== step.id);
          await captureStep(page, actionCase, step, input).catch(() =>
            options.onEvidenceError?.("Step evidence could not be captured"),
          );
        }
        let outcome = await executeStep(page, step, timeoutMs, input);
        if (outcome.ok && outcome.output) {
          const observed = actionCase?.steps.find((entry) => entry.stepId === step.id);
          if (observed) observed.raw = redactValue(outcome.output.value);
          try {
            const schema = action.outputs[outcome.output.key];
            if (schema)
              outcome.output.value = coerceValue(
                schema,
                outcome.output.value,
                `${name}.${outcome.output.key}`,
              );
          } catch (error) {
            outcome = { ok: false, type: "extraction-failed", message: String(error) };
          }
        }
        if (!outcome.ok) {
          const failure = await toFailure(page, runId, action, step, outcome);
          if (actionCase && options.cases?.saveFailure) {
            const after = await captureStructure(page);
            await options.cases
              .saveFailure({
                ...structuredClone(actionCase),
                after,
                fingerprint: fingerprint({ stepId: step.id, type: outcome.type, html: after.html }),
                failure: { stepId: step.id, type: outcome.type },
              })
              .catch(() => options.onEvidenceError?.("Failure evidence could not be persisted"));
          }
          // A timed-out completion is not a locator repair and cannot repeat the click.
          if (
            step.type === "click" &&
            step.completion &&
            (await observeCondition(page, step.completion, input, before))
          ) {
            completedSteps.push(step.id);
            continue;
          }
          if (options.repair && !attempted.has(step.id)) {
            attempted.add(step.id);
            const next = await options.repair({
              action,
              implementation,
              inputs: input,
              context: { tab: "active", frame: "main" },
              completedSteps: [...completedSteps],
              failedStepIndex: index,
              outputs: extracted,
              before,
              page,
              failure,
            });
            if (next) {
              action = next;
              implementation =
                next.implementations?.find((candidate) => candidate.id === implementation.id) ??
                next.implementation;
              index -= 1;
              continue;
            }
          }
          throw new HostActionError(outcome.message, failure);
        }
        if (outcome.output !== undefined) extracted[outcome.output.key] = outcome.output.value;
        if (actionCase && outcome.output) {
          actionCase.expectations.push({
            stepId: step.id,
            value: redactValue(outcome.output.value),
            provenance: "observed",
          });
        }
        completedSteps.push(step.id);
      }

      if (implementation.completion) {
        try {
          await waitCondition(
            page,
            implementation.completion,
            input,
            implementation.conditionTimeoutMs ?? timeoutMs,
            before,
          );
        } catch (error) {
          const type = implementation.steps.some((step) => step.type === "click")
            ? "uncertain-outcome"
            : "condition-failed";
          throw new HostActionError(
            String(error),
            await toFailure(page, runId, action, implementation.steps.at(-1)!, {
              type,
              message: String(error),
            }),
          );
        }
      }
      const output: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(action.outputs)) {
        output[key] = coerceValue(schema, extracted[key], `${name}.${key}`);
      }
      await options.onSuccess?.(action, input, output, implementation);
      if (actionCase && options.cases)
        await options.cases
          .save(await finishCase(page, actionCase, action, implementation, output))
          .catch(() => options.onEvidenceError?.("Successful case could not be persisted"));
      byName.set(name, action);
      return output;
    },
  };
}

export function createStubHost(
  handlers: Record<string, (args: unknown) => unknown | Promise<unknown>>,
): ActionHost {
  return {
    async invoke(name, args) {
      const handler = handlers[name];
      if (handler === undefined) throw new HostActionError(`Unknown action: ${name}`);
      return await handler(args);
    },
  };
}

async function toFailure(
  page: Page,
  runId: string,
  action: SiteActionDefinition,
  step: Step,
  outcome: {
    type: AutomationFailure["error"]["type"];
    message: string;
    evidence?: AutomationFailure["evidence"];
  },
): Promise<AutomationFailure> {
  const title = await page.title().catch(() => undefined);
  return {
    runId,
    automationId: action.id,
    actionId: action.id,
    stepId: step.id,
    step,
    error: { type: outcome.type, message: outcome.message },
    page:
      title === undefined || title.length === 0 ? { url: page.url() } : { url: page.url(), title },
    artifacts: {},
    ...(outcome.evidence === undefined ? {} : { evidence: outcome.evidence }),
  };
}

function extractionOptionality(step: Step, action: SiteActionDefinition): Step {
  if (step.type !== "extract-list") return step;
  const schema = action.outputs[step.output];
  if (schema?.type !== "array" || schema.items.type !== "object") return step;
  const properties = schema.items.properties;
  return {
    ...step,
    fields: Object.fromEntries(
      Object.entries(step.fields).map(([key, field]) => [
        key,
        { ...field, optional: properties[key]?.optional === true },
      ]),
    ),
  };
}

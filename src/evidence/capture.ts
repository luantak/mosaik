import { createHash, randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { ActionImplementation, SiteActionDefinition } from "../capabilities/types.js";
import type { Step } from "../core/types.js";
import { resolveLocator } from "../runtime/locators.js";
import type { ActionCase, DomEvidence } from "./types.js";

export function fingerprint(value: unknown): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, stable(value)]),
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
export function contractFingerprint(
  action: SiteActionDefinition,
  selected: ActionImplementation = action.implementation,
): string {
  return fingerprint({
    inputs: action.inputs,
    outputs: action.outputs,
    contractVersion: action.contractVersion ?? 1,
    conditions: {
      id: selected.id ?? "default",
      precondition: selected.precondition,
      completion: selected.completion,
      boundaries: selected.steps.map((step) => ({
        id: step.id,
        ready: step.ready,
        completion: step.completion,
        empty: step.type === "extract-list" ? step.empty : undefined,
      })),
    },
  });
}
/** No values from credentials, form fields, text, URLs or custom attributes leave the page. */
export async function captureStructure(page: Page, maxBytes = 64_000): Promise<DomEvidence> {
  const snapshot = await page
    .evaluate(() => {
      const root = document.documentElement.cloneNode(true) as HTMLElement;
      root
        .querySelectorAll("script,style,link,meta,iframe,object,embed,template")
        .forEach((el) => el.remove());
      for (const element of [root, ...root.querySelectorAll("*")]) {
        // Snapshot the live attribute collection before removing its entries.
        const attributes = Array.from(element.attributes);
        for (const attribute of attributes) element.removeAttribute(attribute.name);
        for (const child of element.childNodes) {
          if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.COMMENT_NODE)
            child.textContent = "";
        }
      }
      return {
        html: root.outerHTML,
        shadow: [...document.querySelectorAll("*")].some((el) => el.shadowRoot !== null),
      };
    })
    .catch(() => ({ html: "", shadow: true }));
  const complete = Buffer.byteLength(snapshot.html) <= maxBytes && !snapshot.shadow;
  return {
    html: complete ? snapshot.html : "",
    complete,
    redacted: true,
    unsupported: [
      "text",
      "attributes",
      "visibility",
      "accessibility",
      "shadow-dom",
      "application-state",
    ],
  };
}
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [key, redactValue(value)]),
    );
  return value === undefined ? undefined : "[redacted]";
}
function redactConditionEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConditionEvidence);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        ["kind", "strategy", "comparison"].includes(key)
          ? item
          : typeof item === "string"
            ? "[redacted]"
            : redactConditionEvidence(item),
      ]),
    );
  return value;
}

export async function beginCase(
  page: Page,
  action: SiteActionDefinition,
  implementation: ActionImplementation,
  inputs: Record<string, unknown>,
  runId: string,
): Promise<ActionCase> {
  const before = await captureStructure(page);
  return {
    schemaVersion: 1,
    id: randomUUID(),
    siteId: action.siteId,
    actionId: action.id,
    implementationId: implementation.id ?? "default",
    contractVersion: action.contractVersion ?? 1,
    contractFingerprint: contractFingerprint(action, implementation),
    implementationVersion: action.version,
    runId,
    capturedAt: Date.now(),
    context: { tab: "active", frame: "main" },
    inputs: redactValue(inputs) as Record<string, unknown>,
    inputsComplete: Object.keys(inputs).length === 0,
    before,
    after: before,
    ...(implementation.precondition
      ? {
          precondition: redactConditionEvidence(
            implementation.precondition,
          ) as import("../core/types.js").Condition,
        }
      : {}),
    ...(implementation.completion
      ? {
          completion: redactConditionEvidence(
            implementation.completion,
          ) as import("../core/types.js").Condition,
        }
      : {}),
    observations: { precondition: implementation.precondition ? true : null, completion: null },
    steps: [],
    output: undefined,
    expectations: [],
    fingerprint: "",
  };
}
export async function captureStep(
  page: Page,
  record: ActionCase,
  step: Step,
  inputs: Record<string, unknown>,
): Promise<void> {
  const dom = await captureStructure(page);
  if (!("locator" in step)) {
    record.steps.push({ stepId: step.id, dom });
    return;
  }
  const target = resolveLocator(page, step.locator, inputs);
  const matches = await target.count();
  const tags =
    matches <= 100
      ? await target.evaluateAll((elements) =>
          elements.map((element) => element.tagName.toLowerCase()),
        )
      : undefined;
  record.steps.push({ stepId: step.id, dom, matches, ...(tags ? { tags } : {}) });
}
export async function finishCase(
  page: Page,
  record: ActionCase,
  action: SiteActionDefinition,
  implementation: ActionImplementation,
  output: unknown,
): Promise<ActionCase> {
  record.after = await captureStructure(page);
  record.output = redactValue(output);
  record.implementationVersion = action.version;
  record.contractFingerprint = contractFingerprint(action, implementation);
  record.observations.completion = implementation.completion ? true : null;
  record.fingerprint = fingerprint({
    before: record.before.html,
    after: record.after.html,
    steps: record.steps.map((step) => ({
      id: step.stepId,
      html: step.dom.html,
      matches: step.matches,
    })),
    output: record.output,
  });
  return record;
}

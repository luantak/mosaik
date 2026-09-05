import type { Browser } from "playwright";
import type { SiteActionDefinition } from "../capabilities/types.js";
import { coerceValue } from "../capabilities/schema.js";
import { inputReferences } from "../capabilities/contracts.js";
import { executeStep } from "../runtime/execute.js";
import { observeCondition } from "../runtime/conditions.js";
import { resolveLocator } from "../runtime/locators.js";
import type { LocatorDefinition } from "../core/types.js";
import { contractFingerprint } from "./capture.js";
import type { ActionCase, CaseCheck, DomEvidence } from "./types.js";

// Only tag/child selectors survive structure-only redaction. Browser-derived
// visibility, accessible names and shadow roots are never inferred from HTML.
function supported(locator: LocatorDefinition, dom: DomEvidence): boolean {
  if (!dom.complete) return false;
  if (
    locator.within &&
    (locator.within.kind !== "container" || !supported(locator.within.locator, dom))
  )
    return false;
  if (
    locator.strategy === "css" &&
    /:(?:visible|hidden|hover|active|focus|checked|has-text|text)(?:\b|\()/i.test(locator.selector)
  )
    return false;
  if (dom.redacted)
    return (
      !locator.within &&
      !locator.bindings &&
      !locator.attribute &&
      locator.strategy === "css" &&
      /^[a-zA-Z*\s>,+~]+$/.test(locator.selector)
    );
  return locator.strategy === "css" || locator.strategy === "test-id";
}
export async function checkHistoricalCases(
  browser: Browser,
  candidate: SiteActionDefinition,
  cases: ActionCase[],
): Promise<CaseCheck[]> {
  const checks: CaseCheck[] = [];
  const context = await browser.newContext({
    javaScriptEnabled: false,
    offline: true,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  await context.route("**/*", (route) => route.abort());
  try {
    const page = await context.newPage();
    for (const record of cases) {
      const report = (check: string, status: CaseCheck["status"], reason: string) =>
        checks.push({
          caseId: record.id,
          caseVersion: record.schemaVersion,
          implementationVersion: record.implementationVersion,
          check,
          status,
          reason,
        });
      const implementation =
        candidate.implementations?.find((value) => value.id === record.implementationId) ??
        (record.implementationId === "default" ? candidate.implementation : undefined);
      if (!implementation) {
        report("implementation", "fail", "Previously supported implementation was removed");
        continue;
      }
      if (
        record.schemaVersion !== 1 ||
        record.contractVersion !== (candidate.contractVersion ?? 1) ||
        record.contractFingerprint !== contractFingerprint(candidate, implementation)
      ) {
        report("contract", "inconclusive", "Contract or case version differs");
        continue;
      }
      if (implementation.precondition) {
        const condition = implementation.precondition;
        if (
          condition.kind !== "count" ||
          !supported(condition.locator, record.before) ||
          (!record.inputsComplete && inputReferences(condition).length)
        )
          report(
            "precondition",
            "inconclusive",
            "Starting condition requires unavailable browser or redacted evidence",
          );
        else {
          await page.setContent(record.before.html, { waitUntil: "domcontentloaded" });
          report(
            "precondition",
            (await observeCondition(page, condition, record.inputs)) ? "pass" : "fail",
            "Offline target-count condition",
          );
        }
      }
      for (const step of implementation.steps) {
        if (!("locator" in step)) continue;
        const evidence = record.steps.find((entry) => entry.stepId === step.id);
        if (
          !evidence ||
          !supported(step.locator, evidence.dom) ||
          (!record.inputsComplete && inputReferences(step).length)
        ) {
          report(
            step.id,
            "inconclusive",
            "Missing, truncated, redacted or unsupported selector evidence",
          );
          continue;
        }
        await page.setContent(evidence.dom.html, { waitUntil: "domcontentloaded" });
        try {
          const target = resolveLocator(page, step.locator, record.inputs);
          const count = await target.count();
          if (evidence.matches === undefined) {
            report(step.id, "inconclusive", "No observed target count");
            continue;
          }
          if (count !== evidence.matches || (step.type !== "extract-list" && count !== 1)) {
            report(step.id, "fail", `Target count changed from ${evidence.matches} to ${count}`);
            continue;
          }
          if (evidence.tags) {
            const tags = await target.evaluateAll((elements) =>
              elements.map((element) => element.tagName.toLowerCase()),
            );
            if (JSON.stringify(tags) !== JSON.stringify(evidence.tags)) {
              report(step.id, "fail", "Target element types changed");
              continue;
            }
          }
          report(
            `${step.id}:targets`,
            "pass",
            "Target count and available element types match; behavior is untested",
          );
          if (step.type !== "extract-list" && step.type !== "extract-text") continue;
          if (
            evidence.dom.redacted ||
            step.ready ||
            step.completion ||
            (step.type === "extract-list" &&
              (step.empty ||
                Object.values(step.fields).some(
                  (field) =>
                    field.source === "url" ||
                    (field.locator && !supported(field.locator, evidence.dom)),
                )))
          ) {
            report(
              `${step.id}:extraction`,
              "inconclusive",
              "Extraction needs redacted or live readiness evidence",
            );
            continue;
          }
          const result = await executeStep(page, step, 100, record.inputs);
          if (!result.ok) {
            report(`${step.id}:extraction`, "fail", result.message);
            continue;
          }
          const expected = record.expectations.find(
            (value) => value.stepId === step.id && value.provenance === "independently-asserted",
          );
          if (!expected) {
            report(
              `${step.id}:parsing`,
              "inconclusive",
              "Observed output is not an independently asserted expectation",
            );
            continue;
          }
          let value: unknown;
          try {
            value = coerceValue(candidate.outputs[step.output]!, result.output?.value, step.output);
          } catch (error) {
            report(
              `${step.id}:parsing`,
              "fail",
              `Asserted fixture cannot be parsed: ${String(error)}`,
            );
            continue;
          }
          report(
            `${step.id}:parsing`,
            JSON.stringify(value) === JSON.stringify(expected.value) ? "pass" : "fail",
            "Compared against an independently asserted fixture",
          );
        } catch (error) {
          report(step.id, "inconclusive", `Offline check could not complete: ${String(error)}`);
        }
      }
      report(
        "behavior",
        "inconclusive",
        "Offline DOM cannot establish navigation, submission or application completion",
      );
    }
  } finally {
    await context.close();
  }
  return checks;
}

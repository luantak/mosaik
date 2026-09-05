import type { Page } from "playwright";
import { observeCondition } from "../../runtime/conditions.js";
import { validateCondition } from "../../capabilities/contracts.js";
import type { Condition } from "../../core/types.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AutomationExecutionResult } from "../../automations/types.js";

/** Discovery observations are evidence, not a successful execution of the saved automation. */
export async function readDiscoveryEvidence(directory: string): Promise<AutomationExecutionResult> {
  const observations: unknown[] = [];
  let pageNavigation: AutomationExecutionResult["pageNavigation"];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, "mosaik-observations.json");
    try {
      files.push({ path, modified: (await stat(path)).mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  files.sort((a, b) => a.modified - b.modified);
  for (const file of files) {
    try {
      const evidence = JSON.parse(await readFile(file.path, "utf8"));
      observations.push(...evidence.observations);
      pageNavigation = evidence.pageNavigation ?? pageNavigation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    success: true,
    origin: "discovery",
    discoveryObservations: observations,
    actionCalls: [],
    logs: [],
    ...(pageNavigation ? { pageNavigation } : {}),
  };
}

/** Historical observations cannot stand in for the invocation tab's current state. */
export async function discoveryEvidenceIsCurrent(
  page: Page | undefined,
  evidence: AutomationExecutionResult,
): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  const latest = evidence.discoveryObservations?.at(-1);
  if (!latest || typeof latest !== "object") return false;
  const observation = latest as Record<string, unknown>;
  if (typeof observation.page !== "string" || page.url() !== observation.page) return false;
  try {
    if (observation.completion !== undefined) {
      validateCondition(observation.completion as Condition);
      return await observeCondition(
        page,
        observation.completion as Condition,
        (observation.inputs ?? {}) as Record<string, unknown>,
      );
    }
    return true;
  } catch {
    return false;
  }
}

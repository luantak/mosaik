import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MosaikStore } from "./persist/repository.js";
import { automationSourcePath } from "./library/paths.js";
import { automationInputSchema, validateAutomationInputs } from "./library/automation-inputs.js";
import { parseAutomationImports } from "./library/automation-imports.js";
import { referencedActions, validateAutomation } from "./automations/validate.js";
import { resolveAutomationActions } from "./automations/dependencies.js";
import { runAutomation } from "./automations/run.js";
import type { AutomationExecutionResult, ComposedAutomation } from "./automations/types.js";
import type { BrowserSession } from "./runtime/session.js";
import type { Browser } from "playwright";
import type { TaskAssessment } from "./automations/acceptance.js";
import { fingerprint } from "./jobs/fingerprint.js";

export interface PreparedSavedAutomation {
  automation: ComposedAutomation;
  input: Record<string, unknown>;
  startUrl: string;
  sourcePath: string;
  sources: Map<string, string>;
}

/** Load and validate a selected saved program. Never invokes a composition/model agent. */
export async function prepareSavedAutomation(
  store: MosaikStore,
  options: {
    siteId: string;
    automationId: string;
    inputs: Record<string, unknown>;
    startUrl?: string;
  },
): Promise<PreparedSavedAutomation> {
  assertAutomationId(options.automationId);
  const loaded = await store.getAutomation(options.siteId, options.automationId);
  if (!loaded) throw new Error(`No saved automation ${options.automationId} for ${options.siteId}`);
  // Source is canonical: edits to the public type invalidate stale metadata immediately.
  const inputs = automationInputSchema(loaded.source);
  const input = validateAutomationInputs(inputs, options.inputs);
  const startUrl = options.startUrl ?? loaded.startUrl;
  if (!startUrl) throw new Error("This automation has no saved start URL; supply --url");
  const url = new URL(startUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Saved automation start URL must use http or https");
  const sources = new Map<string, string>();
  const dependencies = new Map<string, NonNullable<ComposedAutomation["dependencies"]>[number]>();
  const visit = async (automation: ComposedAutomation, depth: number): Promise<void> => {
    if (depth > 1) throw new Error("Nested automation imports are limited to one level");
    if (sources.has(automation.id))
      throw new Error("Automation import cycle or repeated dependency");
    const actions = await resolveAutomationActions(store.siteActions, automation);
    validateAutomation(automation.source, {
      actionNames: actions.map((action) => action.name),
      libraryRoot: store.libraryRoot,
      siteId: automation.siteId,
      automationId: automation.id,
    });
    const referenced = new Set(referencedActions(automation.source));
    for (const action of actions.filter((entry) => referenced.has(entry.name))) {
      if (
        action.safety === "external-side-effect" ||
        [action.implementation, ...(action.implementations ?? [])].some((implementation) =>
          implementation.steps.some((step) => step.safety === "external-side-effect"),
        )
      )
        throw new Error(`Saved execution refuses external side effects: ${action.name}`);
      const declared = automation.dependencies?.find((entry) => entry.actionId === action.id);
      dependencies.set(
        action.id,
        declared ?? {
          actionId: action.id,
          actionVersion: action.version,
          interfaceVersion: action.interfaceVersion,
          inputs: action.inputs,
          outputs: action.outputs,
        },
      );
    }
    sources.set(automation.id, automation.source);
    for (const dependency of parseAutomationImports(automation.source)) {
      if (dependency.kind !== "automation") continue;
      const child = await store.getAutomation(automation.siteId, dependency.automationId);
      if (!child) throw new Error(`Missing imported automation ${dependency.automationId}`);
      await visit(child, depth + 1);
    }
  };
  await visit(loaded, 0);
  return {
    automation: { ...loaded, inputs, startUrl: url.href, dependencies: [...dependencies.values()] },
    input,
    startUrl: url.href,
    sources,
    sourcePath: automationSourcePath(store.libraryRoot, loaded.siteId, loaded.id),
  };
}

/** Resume parameters come only from the durable journal, never new caller input. */
export async function prepareSavedResume(
  store: MosaikStore,
  directory: string,
): Promise<PreparedSavedAutomation> {
  const { inspectJob } = await import("./jobs/store.js");
  const { metadata, summary } = inspectJob(directory);
  if (summary.status === "running")
    throw new Error("Job is locked by a running process; simultaneous resume is unsafe");
  const prepared = await prepareSavedAutomation(store, {
    siteId: metadata.automation.siteId,
    automationId: metadata.automation.id,
    inputs: metadata.input,
    ...(metadata.startUrl === undefined ? {} : { startUrl: metadata.startUrl }),
  });
  if (
    prepared.automation.source !== metadata.automation.source ||
    prepared.automation.version !== metadata.automation.version ||
    fingerprint(prepared.input) !== fingerprint(metadata.input) ||
    (metadata.startUrl !== undefined && prepared.startUrl !== new URL(metadata.startUrl).href)
  )
    throw new Error("Job is incompatible with the saved automation or inputs; start a new job");
  const { prepareResumeMetadata } = await import("./jobs/prepare.js");
  const current = await prepareResumeMetadata(
    directory,
    prepared.automation,
    await resolveAutomationActions(store.siteActions, prepared.automation),
    {
      input: prepared.input,
      startUrl: prepared.startUrl,
      libraryRoot: store.libraryRoot,
      loadAutomationSource: async (id) => prepared.sources.get(id),
    },
  );
  if (current.runtimeFingerprint !== metadata.runtimeFingerprint)
    throw new Error("Job is incompatible with the current runtime fingerprint; start a new job");
  return prepared;
}

export async function executeSavedAutomation(
  browser: Browser | BrowserSession,
  store: MosaikStore,
  prepared: PreparedSavedAutomation,
  options: {
    timeoutMs: number;
    maxActionCalls: number;
    outputDirectory: string;
    signal?: AbortSignal;
    humanize?: boolean;
    job?: { directory: string; resume?: boolean };
  },
): Promise<AutomationExecutionResult> {
  return runAutomation(browser, prepared.automation, {
    registry: store.siteActions,
    input: prepared.input,
    startUrl: prepared.startUrl,
    ...options,
    libraryRoot: store.libraryRoot,
    loadAutomationSource: async (id) => prepared.sources.get(id),
    haltBefore: (step) => step.safety === "external-side-effect",
  });
}

export function savedExecutionExitCode(task: TaskAssessment): number {
  return task.status === "complete"
    ? 0
    : task.status === "incomplete"
      ? 2
      : task.status === "interrupted"
        ? 130
        : 1;
}

export function savedJobResumeCommand(
  directory: string,
  options: {
    dataDirectory?: string;
    browser?: string;
    headless?: boolean;
    humanize?: boolean;
    kernelProfile?: string;
    kernelAuthConnection?: string;
    kernelStealth?: boolean;
    timeoutMs?: number;
    maxActionCalls?: number;
  } = {},
): string {
  return [
    "mosaik resume",
    quoteShell(directory),
    ...(options.dataDirectory ? ["--data-dir", quoteShell(options.dataDirectory)] : []),
    ...(options.browser ? ["--browser", quoteShell(options.browser)] : []),
    ...(options.headless ? ["--headless"] : []),
    ...(options.humanize === undefined ? [] : [options.humanize ? "--humanize" : "--no-humanize"]),
    ...(options.kernelProfile ? ["--kernel-profile", quoteShell(options.kernelProfile)] : []),
    ...(options.kernelAuthConnection
      ? ["--kernel-auth-connection", quoteShell(options.kernelAuthConnection)]
      : []),
    ...(options.kernelStealth ? ["--kernel-stealth"] : []),
    ...(options.timeoutMs === undefined ? [] : ["--timeout", String(options.timeoutMs)]),
    ...(options.maxActionCalls === undefined
      ? []
      : ["--max-action-calls", String(options.maxActionCalls)]),
  ].join(" ");
}

export async function inspectSavedAutomation(store: MosaikStore, siteId: string, id: string) {
  assertAutomationId(id);
  const automation = await store.getAutomation(siteId, id);
  if (!automation) throw new Error(`No saved automation ${id} for ${siteId}`);
  return {
    ...automation,
    inputs: automationInputSchema(automation.source),
    sourcePath: automationSourcePath(store.libraryRoot, automation.siteId, id),
  };
}

export function savedAutomationRerunCommand(options: {
  automationId: string;
  siteId: string;
  inputs: Record<string, unknown>;
  startUrl?: string;
  dataDirectory?: string;
  browser?: string;
  headless?: boolean;
  humanize?: boolean;
  kernelProfile?: string;
  kernelAuthConnection?: string;
  kernelStealth?: boolean;
}): string {
  return [
    "mosaik execute",
    quoteShell(options.automationId),
    "--site",
    quoteShell(options.siteId),
    ...(options.startUrl ? ["--url", quoteShell(options.startUrl)] : []),
    ...(options.dataDirectory ? ["--data-dir", quoteShell(options.dataDirectory)] : []),
    ...(options.browser ? ["--browser", quoteShell(options.browser)] : []),
    ...(options.headless ? ["--headless"] : []),
    ...(options.humanize === undefined ? [] : [options.humanize ? "--humanize" : "--no-humanize"]),
    ...(options.kernelProfile ? ["--kernel-profile", quoteShell(options.kernelProfile)] : []),
    ...(options.kernelAuthConnection
      ? ["--kernel-auth-connection", quoteShell(options.kernelAuthConnection)]
      : []),
    ...(options.kernelStealth ? ["--kernel-stealth"] : []),
    "--input-json",
    quoteShell(JSON.stringify(options.inputs)),
  ].join(" ");
}

export async function persistSavedExecutionReport(
  directory: string,
  report: unknown,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "execution.json");
  const temporary = join(directory, `.execution-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(report, null, 2) + "\n");
  await rename(temporary, path);
  return path;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertAutomationId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes(".."))
    throw new Error(
      "Automation ID must contain letters, numbers, dots, underscores, or dashes and cannot contain '..'",
    );
}

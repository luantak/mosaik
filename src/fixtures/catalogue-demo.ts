#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright";
import type { RepairAgent } from "../agents/types.js";
import { runAutomation } from "../automations/run.js";
import type { AutomationExecutionResult } from "../automations/types.js";
import { inspectJob } from "../jobs/store.js";
import type { JobSummary } from "../jobs/types.js";
import { prepareSavedAutomation } from "../saved-execution.js";
import {
  CATALOGUE_RECORDS,
  expectedCatalogueRecords,
  seedCatalogueAutomation,
  startCatalogueFixture,
  type CatalogueFixture,
  type CatalogueResult,
} from "./catalogue.js";

export interface CatalogueMeasurement {
  scenario: string;
  correctness: "passed";
  durationMs: number;
  modelRequests: number;
  inputTokens: number;
  outputTokens: number;
  repairs: number;
  collected: number;
  failedItems?: number;
  status?: string;
  termination?: string | null;
  outputPath?: string;
  completedBeforeKill?: number;
  fakeAgentCalls?: number;
  regressionChecks?: string[];
}

type Seed = Awaited<ReturnType<typeof seedCatalogueAutomation>>;
interface CliReport {
  status: string;
  execution: AutomationExecutionResult;
  metrics: {
    durationMs: number;
    modelRequests: number;
    inputTokens: number;
    outputTokens: number;
    repairs: number;
  };
  error?: string;
}

/** Read a fixture-sized artifact. The production writer itself streams records. */
export async function verifyCatalogueOutput(
  path: string,
  expected: CatalogueResult[],
): Promise<void> {
  const records = (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CatalogueResult);
  assert.equal(
    new Set(records.map((record) => record.id)).size,
    records.length,
    "duplicate committed record IDs",
  );
  assert.deepEqual(
    [...records].sort(byRecordId),
    [...expected].sort(byRecordId),
    "records must match independent fixture data exactly",
  );
}

/** Real child CLI execution and real SIGKILL. No agent or provider is used. */
export async function runProcessRecoveryEvaluation(
  directory: string,
  fixture: CatalogueFixture,
  options: { count?: number; killAfter?: number } = {},
): Promise<CatalogueMeasurement> {
  const started = performance.now();
  const count = options.count ?? 1_200;
  const killAfter = options.killAfter ?? 60;
  assert.ok(killAfter > 0 && killAfter < count);
  const seeded = await seedCatalogueAutomation(directory, fixture.origin);
  const jobDirectory = join(directory, "jobs", "crash-recovery");
  fixture.controls.delayMs = 2;
  const first = launchCli(directory, executeArguments(seeded.siteId, jobDirectory, "all", count));
  let completedIds: string[] = [];
  let lastPrinted = 0;
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (first.exited())
        throw new Error(
          `CLI stopped before interruption threshold: ${(await first.done).stdout}\n${(await first.done).stderr}`,
        );
      if (existsSync(join(jobDirectory, "job.sqlite"))) {
        let snapshot: JobSummary | undefined;
        try {
          snapshot = inspectJob(jobDirectory).summary;
        } catch (error) {
          // The database can exist before its initial schema transaction commits.
          if (!/no such table|format|undefined|SQLITE_BUSY|locked/.test(String(error))) throw error;
        }
        if (snapshot && snapshot.collected >= killAfter) {
          completedIds = committedIds(snapshot.databasePath);
          first.child.kill("SIGKILL");
          break;
        }
        if (snapshot && Date.now() - lastPrinted > 10_000) {
          process.stderr.write(`Crash demonstration: ${snapshot.collected} records committed\n`);
          lastPrinted = Date.now();
        }
      }
      await delay(50);
    }
    if (!completedIds.length)
      throw new Error("Timed out waiting for committed records before SIGKILL");
    const killed = await first.done;
    assert.equal(killed.signal, "SIGKILL");
    await writeFile(join(directory, "killed-cli.stderr.log"), killed.stderr);
    const interrupted = inspectJob(jobDirectory);
    assert.equal(interrupted.summary.status, "interrupted");
    assert.ok(interrupted.summary.collected >= completedIds.length);
    const requestsAtKill = new Map(fixture.requests.details);
    await cli(directory, ["jobs", "export", jobDirectory, "--json"]);
    const exportedPartial = inspectJob(jobDirectory).summary;
    const partialRows = (await readFile(exportedPartial.outputPath, "utf8")).trim().split("\n");
    assert.equal(partialRows.length, exportedPartial.collected);
    fixture.controls.delayMs = 0;
    process.stderr.write(
      `SIGKILL after ${interrupted.summary.collected} commits; resuming in a new CLI process\n`,
    );
    const resumed = await cli(directory, ["resume", jobDirectory, ...commonArguments()]);
    const report = parseReport(resumed.stdout);
    assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
    assert.equal(report.status, "complete");
    assert.equal(report.metrics.modelRequests, 0);
    const summary = inspectJob(jobDirectory).summary;
    await verifyCatalogueOutput(
      summary.outputPath,
      expectedCatalogueRecords(fixture.origin, "all", count),
    );
    for (const id of completedIds)
      assert.equal(
        fixture.requests.details.get(id),
        requestsAtKill.get(id),
        `completed item ${id} was replayed`,
      );
    return {
      scenario: "saved CLI, SIGKILL and process resume",
      correctness: "passed",
      durationMs: elapsed(started),
      modelRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      repairs: summary.repairs,
      collected: summary.collected,
      completedBeforeKill: interrupted.summary.collected,
      status: summary.status,
      termination: summary.termination,
      outputPath: summary.outputPath,
    };
  } finally {
    if (!first.exited()) {
      first.child.kill("SIGKILL");
      await first.done;
    }
    fixture.controls.delayMs = 0;
  }
}

export async function runChangedInputsEvaluation(
  directory: string,
  fixture: CatalogueFixture,
): Promise<CatalogueMeasurement[]> {
  const seeded = await seedCatalogueAutomation(directory, fixture.origin);
  const measurements: CatalogueMeasurement[] = [];
  for (const category of ["books", "games"]) {
    const started = performance.now();
    const result = await cli(
      directory,
      executeArguments(seeded.siteId, join(directory, "jobs", category), category, 25),
    );
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const report = parseReport(result.stdout);
    assert.equal(report.metrics.modelRequests, 0);
    const summary = report.execution.job!;
    await verifyCatalogueOutput(
      summary.outputPath,
      expectedCatalogueRecords(fixture.origin, category, 25),
    );
    measurements.push({
      scenario: `same saved automation, category=${category}`,
      correctness: "passed",
      ...report.metrics,
      durationMs: elapsed(started),
      collected: summary.collected,
      status: summary.status,
      termination: summary.termination,
      outputPath: summary.outputPath,
    });
  }
  return measurements;
}

/** Tests real browser actions and retries; the expected result is fixture data, not agent judgment. */
export async function runPartialEvaluation(
  directory: string,
  browser: Browser,
): Promise<CatalogueMeasurement[]> {
  const fixture = await startCatalogueFixture();
  try {
    for (const record of CATALOGUE_RECORDS.slice(12)) fixture.controls.omittedIds.add(record.id);
    fixture.controls.unavailableIds.add("record-0002");
    fixture.controls.transientFailures.set("record-0003", 2);
    fixture.controls.malformedIds.add("record-0004");
    const seed = await seedCatalogueAutomation(directory, fixture.origin);
    const started = performance.now();
    const result = await runSeed(browser, seed, join(directory, "jobs", "partial"), 12);
    assert.equal(result.success, true, result.error);
    assert.equal(result.task?.status, "incomplete");
    assert.equal(result.job?.termination, "source-exhausted");
    assert.equal(result.job?.failed, 2);
    assert.equal(result.job?.collected, 10);
    assert.equal(
      fixture.requests.details.get("record-0002"),
      3,
      "unavailable retries must be bounded",
    );
    assert.equal(
      fixture.requests.details.get("record-0003"),
      3,
      "transient failure should recover after two retries",
    );
    assert.equal(
      fixture.requests.details.get("record-0004"),
      1,
      "malformed data must not be retried as transient",
    );
    const expected = expectedCatalogueRecords(fixture.origin, "all", 12).filter(
      (record) => !["record-0002", "record-0004"].includes(record.id),
    );
    await verifyCatalogueOutput(result.job!.outputPath, expected);
    const failures = await readFile(result.job!.failuresPath, "utf8");
    assert.match(failures, /record-0002/);
    assert.match(failures, /record-0004/);
    assert.match(failures, /required field title/);
    const partial = measurement(
      "partial unavailable/malformed records; transient recovery",
      result,
      started,
    );
    fixture.controls.unavailableIds.clear();
    fixture.controls.malformedIds.clear();
    const missingStarted = performance.now();
    const missing = await runSeed(browser, seed, join(directory, "jobs", "missing"), 15);
    assert.equal(missing.success, true, missing.error);
    assert.equal(missing.task?.status, "incomplete");
    assert.equal(missing.job?.failed, 0);
    assert.equal(missing.job?.collected, 12);
    assert.equal(missing.job?.termination, "source-exhausted");
    await verifyCatalogueOutput(
      missing.job!.outputPath,
      expectedCatalogueRecords(fixture.origin, "all", 12),
    );
    return [
      partial,
      measurement("requested count exceeds exhausted source", missing, missingStarted),
    ];
  } finally {
    await fixture.close();
  }
}

/** Deterministic fake-agent repair regression. This is NOT a provider evaluation. */
export async function runRepairEvaluation(
  directory: string,
  browser: Browser,
): Promise<CatalogueMeasurement> {
  const fixture = await startCatalogueFixture();
  const started = performance.now();
  try {
    fixture.controls.newLayoutIds.add("record-0006");
    const seed = await seedCatalogueAutomation(directory, fixture.origin);
    const jobDirectory = join(directory, "jobs", "repair");
    let fakeAgentCalls = 0;
    let completedAtRepair = 0;
    const fakeAgent: RepairAgent = {
      async generateRepair(request) {
        fakeAgentCalls++;
        assert.equal(request.mode, "live-continuation");
        assert.equal(request.failure.stepId, "record");
        completedAtRepair = inspectJob(jobDirectory).summary.collected;
        assert.equal(completedAtRepair, 5);
        return {
          success: true,
          validated: false,
          patches: [
            {
              type: "replace-locator",
              stepId: "record",
              locator: { strategy: "css", selector: ".record,.entry" },
            },
          ],
          modelResponse: "Deterministic fake-agent fixture patch; no model invoked",
          metrics: {
            modelRequests: 0,
            codeExecutions: 0,
            nestedToolCalls: 0,
            durationMs: 0,
            repairSucceeded: true,
          },
          trajectory: [],
        };
      },
    };
    const repaired = await runSeed(browser, seed, jobDirectory, 12, { agent: fakeAgent });
    assert.equal(repaired.success, true, repaired.error);
    assert.equal(repaired.task?.status, "complete");
    assert.equal(repaired.job?.repairs, 1);
    assert.equal(fakeAgentCalls, 1);
    await verifyCatalogueOutput(
      repaired.job!.outputPath,
      expectedCatalogueRecords(fixture.origin, "all", 12),
    );
    for (const record of CATALOGUE_RECORDS.slice(0, completedAtRepair))
      assert.equal(
        fixture.requests.details.get(record.id),
        1,
        "repair must preserve committed work",
      );
    const accepted = inspectJob(jobDirectory).acceptedRepairs;
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.actionId, "catalogue.read-record");
    assert.notEqual(accepted[0]!.fromFingerprint, accepted[0]!.toFingerprint);

    // Independently replay each supported layout using the persisted repaired
    // action. Historical redacted evidence alone does not establish this behavior.
    fixture.controls.newLayoutIds.clear();
    for (const layout of ["old", "new"] as const) {
      fixture.controls.layout = layout;
      const regression = await runSeed(
        browser,
        seed,
        join(directory, "jobs", `regression-${layout}`),
        12,
      );
      assert.equal(regression.task?.status, "complete", regression.error);
      assert.equal(regression.job?.repairs, 0);
      await verifyCatalogueOutput(
        regression.job!.outputPath,
        expectedCatalogueRecords(fixture.origin, "all", 12),
      );
    }
    return {
      ...measurement(
        "fake-agent eligible locator repair and old/new regression",
        repaired,
        started,
      ),
      fakeAgentCalls,
      regressionChecks: [
        "old layout: 12 independent records",
        "new layout: 12 independent records",
        "5 pre-repair commits were not replayed",
      ],
    };
  } finally {
    await fixture.close();
  }
}

export async function runSeed(
  browser: Browser,
  seed: Seed,
  jobDirectory: string,
  count: number,
  options: {
    agent?: RepairAgent;
    signal?: AbortSignal;
    resume?: boolean;
    onActionResult?: (event: { name: string; result: unknown }) => void;
  } = {},
): Promise<AutomationExecutionResult> {
  const prepared = await prepareSavedAutomation(seed.store, {
    siteId: seed.siteId,
    automationId: "catalogue",
    inputs: { category: "all", requestedCount: count },
  });
  return runAutomation(browser, prepared.automation, {
    registry: seed.store.siteActions,
    input: prepared.input,
    startUrl: prepared.startUrl,
    libraryRoot: seed.store.libraryRoot,
    loadAutomationSource: async (id) => prepared.sources.get(id),
    timeoutMs: 60_000,
    maxActionCalls: 300,
    stepTimeoutMs: 500,
    humanize: false,
    outputDirectory: join(jobDirectory, "files"),
    job: { directory: jobDirectory, ...(options.resume ? { resume: true } : {}) },
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onActionResult ? { onActionResult: options.onActionResult } : {}),
  });
}

function measurement(
  scenario: string,
  result: AutomationExecutionResult,
  started: number,
): CatalogueMeasurement {
  const summary = result.job!;
  return {
    scenario,
    correctness: "passed",
    durationMs: elapsed(started),
    modelRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    repairs: summary.repairs,
    collected: summary.collected,
    failedItems: summary.failed,
    status: summary.status,
    termination: summary.termination,
    outputPath: summary.outputPath,
  };
}
function commonArguments(): string[] {
  return [
    "--browser",
    "local",
    "--headless",
    "--no-humanize",
    "--timeout",
    "900000",
    "--max-action-calls",
    "5000",
    "--json",
  ];
}
function executeArguments(site: string, job: string, category: string, count: number): string[] {
  return [
    "execute",
    "catalogue",
    "--site",
    site,
    "--input",
    `category=${category}`,
    "--input",
    `requestedCount=${count}`,
    "--job-dir",
    job,
    ...commonArguments(),
  ];
}
function launchCli(directory: string, args: string[]) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|OPENAI|OPENROUTER|OPENCODE|ANTHROPIC|GEMINI|DEEPSEEK|MOSAIK_DSH_RESOURCE_DIR|MOSAIK_BROWSER_PROXY|MOSAIK_CDP_WS_URL)/.test(
        key,
      )
    )
      delete env[key];
  const source = import.meta.url.endsWith(".ts");
  const prefix = source ? ["--import", fileURLToPath(import.meta.resolve("tsx/esm"))] : [];
  const cliPath = fileURLToPath(new URL(source ? "../cli.ts" : "../cli.js", import.meta.url));
  const child = spawn(process.execPath, [...prefix, cliPath, ...args], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let finished = false;
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolveDone, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 960_000);
    const append = (stream: "stdout" | "stderr", data: Buffer) => {
      if (stdout.length + stderr.length + data.byteLength > 8_388_608) {
        child.kill("SIGKILL");
        reject(new Error("CLI output exceeded demo limit"));
        return;
      }
      if (stream === "stdout") stdout += data.toString();
      else stderr += data.toString();
    };
    child.stdout.on("data", (data: Buffer) => append("stdout", data));
    child.stderr.on("data", (data: Buffer) => append("stderr", data));
    child.once("error", (error) => {
      clearTimeout(timer);
      finished = true;
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      finished = true;
      resolveDone({ code, signal, stdout, stderr });
    });
  });
  return { child, done, exited: () => finished };
}
async function cli(directory: string, args: string[]) {
  const result = await launchCli(directory, args).done;
  if (result.signal) throw new Error(`CLI terminated by ${result.signal}: ${result.stderr}`);
  return result;
}
function parseReport(value: string): CliReport {
  try {
    return JSON.parse(value) as CliReport;
  } catch {
    throw new Error(`CLI did not return JSON: ${value.slice(-4000)}`);
  }
}
function committedIds(databasePath: string): string[] {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db
      .prepare("SELECT id FROM items WHERE state='completed' ORDER BY ordinal")
      .all()
      .map((row) => String(row.id));
  } finally {
    db.close();
  }
}
function byRecordId(left: CatalogueResult, right: CatalogueResult) {
  return left.id.localeCompare(right.id);
}
function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

export async function runCatalogueDemo(outputDirectory: string) {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const started = performance.now();
  const fixture = await startCatalogueFixture();
  const measurements: CatalogueMeasurement[] = [];
  try {
    measurements.push(await runProcessRecoveryEvaluation(join(directory, "project"), fixture));
    measurements.push(...(await runChangedInputsEvaluation(join(directory, "project"), fixture)));
  } finally {
    await fixture.close();
  }
  const browser = await chromium.launch({ headless: true });
  try {
    measurements.push(...(await runPartialEvaluation(join(directory, "partial"), browser)));
    measurements.push(await runRepairEvaluation(join(directory, "repair"), browser));
  } finally {
    await browser.close();
  }
  const report = {
    provenance:
      "Independent local fixture; saved library is hand-authored. Repair uses a deterministic fake agent, not a provider.",
    correctness: "passed",
    durationMs: elapsed(started),
    modelRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    measurements,
  };
  const reportPath = join(directory, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  return { ...report, reportPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseArgs({
    options: { output: { type: "string", default: `.mosaik-bench/catalogue-${Date.now()}` } },
  });
  process.stdout.write(
    JSON.stringify(await runCatalogueDemo(parsed.values.output), null, 2) + "\n",
  );
}

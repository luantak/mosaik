import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { chromium, type Browser } from "playwright";
import { inspectJob } from "../store.js";
import {
  expectedCatalogueRecords,
  seedCatalogueAutomation,
  startCatalogueFixture,
} from "../../fixtures/catalogue.js";
import {
  runPartialEvaluation,
  runProcessRecoveryEvaluation,
  runRepairEvaluation,
  runSeed,
  verifyCatalogueOutput,
} from "../../fixtures/catalogue-demo.js";

let browser: Browser;
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mosaik-job-runtime-"));
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test("batch extraction reports partial records, rejects malformed results and bounds transient retries", async () => {
  const measurements = await runPartialEvaluation(join(root, "partial"), browser);
  assert.equal(measurements.length, 2);
  assert.ok(
    measurements.every((entry) => entry.modelRequests === 0 && entry.status === "incomplete"),
  );
});

test("fake-agent locator repair preserves commits and passes old/new browser regression checks", async () => {
  const result = await runRepairEvaluation(join(root, "repair"), browser);
  assert.equal(result.repairs, 1);
  assert.equal(result.fakeAgentCalls, 1);
  assert.equal(result.modelRequests, 0);
  assert.equal(result.regressionChecks?.length, 3);
});

test("cancellation exposes partial output and deterministic resume does not replay committed items", async () => {
  const fixture = await startCatalogueFixture();
  try {
    const directory = join(root, "cancel");
    const seed = await seedCatalogueAutomation(directory, fixture.origin);
    const jobDirectory = join(directory, "jobs", "interrupted");
    const signal = new AbortController();
    let reads = 0;
    const interrupted = await runSeed(browser, seed, jobDirectory, 12, {
      signal: signal.signal,
      onActionResult: (event) => {
        if (event.name === "readRecord" && ++reads === 6) signal.abort("Focused test interruption");
      },
    });
    assert.equal(interrupted.task?.status, "interrupted");
    const checkpoint = inspectJob(jobDirectory).summary;
    assert.ok(checkpoint.collected >= 4 && checkpoint.collected < 12);
    await verifyCatalogueOutput(
      checkpoint.outputPath,
      expectedCatalogueRecords(fixture.origin, "all", checkpoint.collected),
    );
    const committed = expectedCatalogueRecords(fixture.origin, "all", checkpoint.collected).map(
      (record) => record.id,
    );
    const before = new Map(fixture.requests.details);
    const resumed = await runSeed(browser, seed, jobDirectory, 12, { resume: true });
    assert.equal(resumed.task?.status, "complete", resumed.error);
    await verifyCatalogueOutput(
      resumed.job!.outputPath,
      expectedCatalogueRecords(fixture.origin, "all", 12),
    );
    for (const id of committed) assert.equal(fixture.requests.details.get(id), before.get(id));
  } finally {
    await fixture.close();
  }
});

test("actual CLI SIGKILL and resume retain committed rows without provider credentials", async () => {
  // The full demonstration runs 1,200 rows; this focused test exercises the same
  // separate-process persistence path with fewer rows and one browser at a time.
  await browser.close();
  const fixture = await startCatalogueFixture();
  try {
    const result = await runProcessRecoveryEvaluation(join(root, "process"), fixture, {
      count: 48,
      killAfter: 8,
    });
    assert.equal(result.collected, 48);
    assert.equal(result.modelRequests, 0);
    assert.ok(result.completedBeforeKill! >= 8);
  } finally {
    await fixture.close();
    browser = await chromium.launch({ headless: true });
  }
});

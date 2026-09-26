import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const readResult = async (path) => JSON.parse(await readFile(path, "utf8"));
const recordsFrom = (result) => {
  assert.equal(result.status, "completed", result.reason ?? "Run did not complete");
  assert.equal(result.outcome?.status, "complete", "Outcome review did not confirm completion");
  assert.equal(result.completionMode, "automation", "The saved automation did not run");
  assert.equal(result.automation?.id, "booksCatalogueFive");
  const records = result.execution?.value;
  assert.ok(Array.isArray(records), "Automation did not return an array");
  assert.equal(records.length, 5, "Expected exactly five records");
  const normalized = records.map((record) => {
    assert.ok(typeof record.title === "string" && record.title.length > 0);
    assert.match(record.price, /^£\d+\.\d{2}$/);
    const detailUrl = record.detailUrl ?? record.url;
    assert.match(detailUrl, /^https:\/\/books\.toscrape\.com\/catalogue\//);
    return { title: record.title, price: record.price, detailUrl };
  });
  assert.equal(new Set(normalized.map((item) => item.detailUrl)).size, 5);
  assert.ok(result.execution.actionCalls.length > 0, "No saved action was executed");
  return normalized;
};
const metricsFrom = (result) => ({
  modelRequests: result.metrics.modelRequests,
  totalMs: result.metrics.timings?.totalMs ?? result.metrics.durationMs,
  executionMs: result.metrics.timings?.deterministicExecutionMs ?? null,
  actionsDiscovered: result.metrics.actionsDiscovered,
  actionsReused: result.metrics.actionsReused,
  actionCalls: result.execution.actionCalls.map((call) => call.name),
  runDirectory: result.runDirectory,
});

export async function verifyRuns(firstPath, secondPath) {
  const [first, second] = await Promise.all([readResult(firstPath), readResult(secondPath)]);
  const records = recordsFrom(first);
  assert.deepEqual(recordsFrom(second), records, "The second run returned different records");
  assert.ok(first.discoveredActions.length > 0, "The first run did not discover an action");
  assert.deepEqual(second.discoveredActions, [], "The second run discovered a new action");
  const summary = {
    automationId: first.automation.id,
    recordCount: records.length,
    first: metricsFrom(first),
    second: metricsFrom(second),
  };
  return { summary, records };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [first, second] = process.argv.slice(2);
    if (!first || !second) throw new Error("Usage: node verify.mjs FIRST.json SECOND.json");
    console.log(JSON.stringify((await verifyRuns(first, second)).summary, null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

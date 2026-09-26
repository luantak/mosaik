import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRuns } from "./verify.mjs";

const records = Array.from({ length: 5 }, (_, index) => ({
  title: `Book ${index}`,
  price: "£12.34",
  detailUrl: `https://books.toscrape.com/catalogue/book-${index}`,
}));
const result = (discoveredActions) => ({
  status: "completed",
  outcome: { status: "complete" },
  completionMode: "automation",
  automation: { id: "booksCatalogueFive" },
  discoveredActions,
  execution: { value: records, actionCalls: [{ name: "readStructuredDataFromCurrentPage" }] },
  metrics: { modelRequests: 2, actionsDiscovered: discoveredActions.length, actionsReused: 0 },
});

async function withResults(first, second, check) {
  const root = await mkdtemp(join(tmpdir(), "mosaik-books-verify-"));
  try {
    const paths = [join(root, "first.json"), join(root, "second.json")];
    await Promise.all(
      paths.map((path, index) => writeFile(path, JSON.stringify(index ? second : first))),
    );
    await check(...paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("checks a learned action followed by the same saved execution", async () => {
  await withResults(result(["readStructuredDataFromCurrentPage"]), result([]), async (a, b) => {
    const report = await verifyRuns(a, b);
    assert.equal(report.summary.recordCount, 5);
    assert.deepEqual(report.records, records);
  });
});

test("accepts a generated url key and normalizes the exported records", async () => {
  const asUrl = result(["readCatalogueProducts"]);
  asUrl.execution.value = records.map(({ detailUrl, ...rest }) => ({ ...rest, url: detailUrl }));
  await withResults(asUrl, { ...asUrl, discoveredActions: [] }, async (a, b) => {
    assert.deepEqual((await verifyRuns(a, b)).records, records);
  });
});

test("rejects rediscovery and mismatched data", async () => {
  const first = result(["readStructuredDataFromCurrentPage"]);
  await withResults(first, result(["anotherAction"]), async (a, b) => {
    await assert.rejects(verifyRuns(a, b), /second run discovered/);
  });
  await withResults(
    first,
    { ...result([]), execution: { value: records.slice(1), actionCalls: [{}] } },
    async (a, b) => {
      await assert.rejects(verifyRuns(a, b), /exactly five records/);
    },
  );
});

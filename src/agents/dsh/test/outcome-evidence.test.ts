import assert from "node:assert/strict";
import { test } from "vitest";
import { EvidenceStore } from "../../evidence.js";
import { compactOutcomeEvidence, summarizeOutputFiles } from "../outcome-evidence.js";

test("compact evidence keeps late failures, exact counts and retrievable full records", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    title: "Item " + i,
    href: "https://example.com/" + i,
    ...(i === 55 ? { error: "Download failed" } : { bytes: 100 }),
  }));
  const store = new EvidenceStore();
  const result = compactOutcomeEvidence({ requestedCount: 100, rows }, store) as {
    requestedCount: number;
    rows: {
      totalItems: number;
      recordsWithErrors: number;
      errorSample: unknown[];
      evidenceId: string;
    };
  };
  assert.equal(result.requestedCount, 100);
  assert.equal(result.rows.totalItems, 100);
  assert.equal(result.rows.recordsWithErrors, 1);
  assert.deepEqual(result.rows.errorSample, [rows[55]]);
  assert.deepEqual(JSON.parse(store.entries[result.rows.evidenceId]!), rows);
  assert.ok(JSON.stringify(result).length < JSON.stringify(rows).length / 4);
});
test("file summaries distinguish downloads from manifests and count empty files", () => {
  const files = [
    ...Array.from({ length: 100 }, (_, i) => ({
      relativePath: "covers/" + i + ".jpg",
      bytes: i === 50 ? 0 : 100,
    })),
    { relativePath: "result.json", bytes: 2000 },
  ];
  const summary = summarizeOutputFiles(files, new EvidenceStore()) as Record<string, unknown>;
  assert.equal(summary.totalFiles, 101);
  assert.equal(summary.totalBytes, 11900);
  assert.equal(summary.emptyFiles, 1);
  assert.deepEqual(summary.extensions, { jpg: 100, json: 1 });
});

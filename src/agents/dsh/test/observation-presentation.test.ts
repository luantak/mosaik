import assert from "node:assert/strict";
import { test } from "vitest";
import { EvidenceStore } from "../../evidence.js";
import { presentObservation, withoutObservationLocators } from "../observation-presentation.js";
import { OverviewHistory } from "../overview-history.js";

test("large observations retain identity and retrievable rows with stable deltas", () => {
  const evidence = new EvidenceStore();
  const rows = Array.from({ length: 80 }, (_, index) => ({
    title: `Item ${index}`,
    href: `https://example.com/${index}`,
  }));
  const source = { url: "https://example.com/", title: "Items", regions: [{ controls: rows }] };
  const compact = presentObservation(source, evidence) as typeof source & {
    regions: Array<{
      controls: typeof rows;
      controlsSummary: { evidenceId: string; totalItems: number };
    }>;
  };
  assert.equal(compact.url, source.url);
  assert.equal(compact.regions[0]!.controls.length, 12);
  assert.equal(compact.regions[0]!.controls.at(-1)!.title, "Item 79");
  const summary = compact.regions[0]!.controlsSummary;
  assert.equal(summary.totalItems, 80);
  assert.deepEqual(JSON.parse(evidence.read(summary.evidenceId).text), rows);
  assert.equal(source.regions[0]!.controls.length, 80);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(source).length / 3);
  const history = new OverviewHistory();
  history.present(compact);
  assert.equal(history.present(presentObservation(source, evidence)).unchanged, true);
  rows[25]!.title = "Changed omitted row";
  assert.equal(history.present(presentObservation(source, evidence)).unchanged, false);
});

test("planning strips redundant DOM locators without changing observed URLs or labels", () => {
  const input = {
    headings: [{ level: 1, text: "Guide", locator: { strategy: "css", selector: "main h1" } }],
    links: [
      {
        title: "Next",
        href: "https://example.com/next",
        locator: { strategy: "role", role: "link" },
      },
    ],
  };
  assert.deepEqual(withoutObservationLocators(input), {
    headings: [{ level: 1, text: "Guide" }],
    links: [{ title: "Next", href: "https://example.com/next" }],
  });
  assert.ok(input.headings[0]!.locator);
});

test("sampling retains every structural region and collection", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ name: String(i) }));
  const result = presentObservation(
    { regions: rows, collections: rows, forms: rows, landmarks: rows },
    new EvidenceStore(),
  );
  for (const key of ["regions", "collections", "forms", "landmarks"])
    assert.deepEqual(result[key], rows);
});

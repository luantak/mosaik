import assert from "node:assert/strict";
import { test } from "vitest";
import { OverviewHistory } from "../overview-history.js";

test("overview deltas omit repeated content and preserve changed and removed fields", () => {
  const history = new OverviewHistory();
  const snapshot = {
    url: "https://example.com/",
    title: "Reference",
    regions: [{ controls: "link ".repeat(10000) }],
    headings: ["Overview"],
    inactive: [],
  };
  const first = history.present(snapshot);
  assert.equal(first.full, true);
  const same = history.present(snapshot);
  assert.equal(same.unchanged, true);
  assert.equal(same.baseOverviewId, first.overviewId);
  assert.equal(same.regions, undefined);
  assert.ok(JSON.stringify(same).length < 300);
  const changed = history.present({
    ...snapshot,
    url: "https://example.com/#details",
    headings: ["Details"],
  });
  assert.equal(changed.unchanged, false);
  assert.deepEqual(changed.headings, ["Details"]);
  assert.equal(changed.regions, undefined);
  const removed = history.present({ url: snapshot.url, title: snapshot.title });
  assert.deepEqual(removed.removedFields, ["regions", "headings", "inactive"]);
  const full = history.present(snapshot, true);
  assert.deepEqual(full.regions, snapshot.regions);
});

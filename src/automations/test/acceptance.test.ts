import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assessTask,
  resolveAcceptance,
  validateRecord,
  type TaskAcceptance,
} from "../acceptance.js";

const contract: TaskAcceptance = {
  recordsPath: "records",
  terminationPath: "termination",
  requiredFields: ["id", "title"],
  idField: "id",
  sourceUrlField: "sourceUrl",
  requestedCount: { input: "count" },
};
const record = (id: string) => ({
  id,
  title: `Record ${id}`,
  sourceUrl: `https://example.test/${id}`,
});

test("execution success alone and empty evidence never establish completion", () => {
  assert.equal(assessTask([], undefined, {}, { success: true }).status, "incomplete");
  assert.equal(
    assessTask(
      { records: [], termination: "source-exhausted" },
      contract,
      { count: 1 },
      { success: true },
    ).status,
    "incomplete",
  );
});

test("count reached and exhausted source are explicitly distinct", () => {
  const count = assessTask(
    { records: [record("1")], termination: "requested-count" },
    contract,
    { count: 1 },
    { success: true },
  );
  assert.equal(count.status, "complete");
  assert.equal(count.terminationReason, "requested-count");
  const exhausted = assessTask(
    { records: [record("1")], termination: "source-exhausted" },
    contract,
    { count: 2 },
    { success: true },
  );
  assert.equal(exhausted.status, "incomplete");
  assert.equal(exhausted.terminationReason, "source-exhausted");
  const all = { ...contract, requireExhaustion: true };
  assert.equal(
    assessTask(
      { records: [record("1")], termination: "requested-count" },
      all,
      { count: 1 },
      { success: true },
    ).status,
    "incomplete",
  );
});

test("malformed values, duplicates, source URLs and missing termination fail checks", () => {
  const result = assessTask(
    {
      records: [
        record("1"),
        record("1"),
        { ...record("2"), title: "" },
        { ...record("3"), sourceUrl: "javascript:bad" },
      ],
    },
    contract,
    { count: 4 },
    { success: true },
  );
  assert.equal(result.status, "incomplete");
  assert.equal(result.collected, 1);
  assert.equal(result.failedItems, 3);
  assert.ok(result.errors.some((error) => error.includes("termination")));
});

test("requested count contract is validated before execution", () => {
  for (const count of [undefined, "2", 0, -1, 1.5, Infinity])
    assert.throws(() => resolveAcceptance(contract, { count }));
  assert.throws(
    () =>
      validateRecord(record("1"), {
        ...resolveAcceptance(contract, { count: 1 }),
        requiredFields: ["missing.path"],
      }),
    /missing.path/,
  );
});

test("failed execution and interruption stay distinct from incomplete acceptance", () => {
  assert.equal(assessTask(undefined, contract, {}, { success: false }).status, "failed");
  assert.equal(
    assessTask(undefined, contract, {}, { success: false, interrupted: true }).status,
    "interrupted",
  );
});

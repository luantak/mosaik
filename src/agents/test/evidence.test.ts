import assert from "node:assert/strict";
import { test } from "vitest";
import { EvidenceStore } from "../evidence.js";

test("large repeated evidence has one preview and lossless bounded retrieval", () => {
  const content = "reference paragraph ".repeat(1000);
  const store = new EvidenceStore();
  const presented = store.present({ answer: content, result: content }) as {
    answer: { evidenceId: string };
    result: { evidenceId: string; preview?: string };
  };
  assert.equal(presented.answer.evidenceId, presented.result.evidenceId);
  assert.equal(presented.result.preview, undefined);
  assert.equal(Object.keys(store.entries).length, 1);
  let text = "";
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = store.read(presented.answer.evidenceId, offset, 3000);
    text += page.text;
    offset = page.nextOffset;
  }
  assert.equal(text, content);
  assert.throws(() => store.read("unknown"), /Unknown/);
  assert.throws(() => store.read(presented.answer.evidenceId, -1), /nonnegative/);
  assert.throws(() => store.read(presented.answer.evidenceId, 0, 20000), /16000/);
});

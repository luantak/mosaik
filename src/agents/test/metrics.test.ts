import assert from "node:assert/strict";
import test from "node:test";
import { billedInputTokens, parseDshUsage, usageFromSessionEvent } from "../metrics.js";

test("DSH usage includes cached prompt tokens", () => {
  const usage = parseDshUsage({
    inputTokens: 3,
    outputTokens: 113,
    cacheReadTokens: 2_133,
    cacheWriteTokens: 748,
  });
  assert.equal(billedInputTokens(usage!), 2_884);
});

test("reads usage from DSH events", () => {
  const usage = usageFromSessionEvent({
    type: "assistant/chunk",
    data: {
      chunk: {
        type: "usage",
        usage: { inputTokens: 3, outputTokens: 113, cacheReadTokens: 2_133 },
      },
    },
  });
  assert.equal(billedInputTokens(usage!), 2_136);
  assert.equal(parseDshUsage({ outputTokens: 10 }), undefined);
});

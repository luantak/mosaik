import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { WorkerThreadCodeRuntime } from "@deepseek-ai/dsh-code-runtime-worker-thread";
import { CallId } from "@deepseek-ai/dsh-llm";
import { parseTaskOutcome } from "../../outcome.js";
import { apply } from "../composition-tools.js";

test("outcome mode exposes a working finishOutcome tool without browser or composition access", async () => {
  const ctx = new Context();
  const previous = process.env.MOSAIK_OUTCOME_REVIEW;
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime, { mode: "code", maxParallelSubCalls: 1 });
    await ctx.plugin(WorkerThreadCodeRuntime, {});
    process.env.MOSAIK_OUTCOME_REVIEW = "1";
    await apply(ctx);
    const result = await ctx.tools.execute({
      callId: CallId("outcome-test"),
      name: "run_code",
      arguments: {
        code: 'return await tools.finishOutcome({ status: "incomplete", reason: "No source documents were collected" });',
        description: "Assess missing evidence",
      },
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false);
    assert.deepEqual(parseTaskOutcome(result.value), {
      status: "incomplete",
      reason: "No source documents were collected",
    });
    const unavailable = await ctx.tools.execute({
      callId: CallId("no-composition"),
      name: "run_code",
      arguments: {
        code: "return await tools.finishComposition({});",
        description: "Attempt unavailable tool",
      },
      signal: new AbortController().signal,
    });
    assert.equal(unavailable.isError, true);
  } finally {
    if (previous === undefined) delete process.env.MOSAIK_OUTCOME_REVIEW;
    else process.env.MOSAIK_OUTCOME_REVIEW = previous;
    await ctx.fiber.dispose();
  }
});

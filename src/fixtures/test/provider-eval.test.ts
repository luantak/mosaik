import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { WorkerThreadCodeRuntime } from "@deepseek-ai/dsh-code-runtime-worker-thread";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { DEFAULT_LLM_MODEL } from "../../agents/dsh/llm-route.js";
import {
  parseProviderEvaluationArgs,
  proposedLocator,
  proposalPluginSource,
  runProviderFixtureEvaluation,
} from "../provider-eval.js";

test("provider evaluation requires explicit opt-in and rejects invalid budgets without provider calls", async () => {
  assert.throws(
    () => parseProviderEvaluationArgs([], {}, "/project"),
    /explicit --model and --output/,
  );
  assert.throws(
    () => parseProviderEvaluationArgs(["--model", DEFAULT_LLM_MODEL], {}, "/project"),
    /explicit --model and --output/,
  );
  const parsed = parseProviderEvaluationArgs(
    ["--model", DEFAULT_LLM_MODEL, "--output", "evaluation"],
    {},
    "/project",
  );
  assert.equal(parsed.help, false);
  if (!parsed.help) {
    assert.equal(parsed.options.outputDirectory, "/project/evaluation");
    assert.equal(parsed.options.providerOptIn, true);
    assert.equal(parsed.options.maxModelRequests, 20);
  }
  assert.equal(parseProviderEvaluationArgs([], { MOSAIK_EVAL_PROVIDER: "1" }).help, false);
  assert.deepEqual(parseProviderEvaluationArgs(["--help"], {}), { help: true });
  assert.throws(
    () => parseProviderEvaluationArgs(["--max-model-requests", "0"], { MOSAIK_EVAL_PROVIDER: "1" }),
    /between 1 and 100/,
  );
  await assert.rejects(
    runProviderFixtureEvaluation({ providerOptIn: false } as never),
    /Explicit provider evaluation opt-in/,
  );
});

test("provider locator proposals are structural proposals, never claims of successful repair", () => {
  assert.deepEqual(
    proposedLocator({
      result: { status: "locator-proposed", locator: { strategy: "css", selector: "article" } },
    }),
    { strategy: "css", selector: "article" },
  );
  assert.equal(
    proposedLocator({ status: "complete", locator: { strategy: "css", selector: "article" } }),
    undefined,
  );
  assert.equal(
    proposedLocator({ status: "locator-proposed", locator: { strategy: "css" } }),
    undefined,
  );
  assert.equal(
    proposedLocator({
      status: "locator-proposed",
      locator: { strategy: "execute", code: "anything" },
    }),
    undefined,
  );
});

test("repair evaluation tool profile exposes only proposal submission, without a provider or browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-eval-tools-"));
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime, { mode: "ptc", maxParallelSubCalls: 1 });
    await ctx.plugin(WorkerThreadCodeRuntime, {});
    const path = join(root, "proposal.mjs");
    await writeFile(path, proposalPluginSource(import.meta.resolve("@deepseek-ai/dsh-tools")));
    const plugin = await import(pathToFileURL(path).href);
    await plugin.apply(ctx);
    const result = await ctx.tools.execute({
      callId: ToolCallId("proposal-only"),
      name: "run_code",
      arguments: {
        code: `return await tools.proposeLocator({ locator: JSON.stringify({ strategy: "css", selector: "article" }) });`,
        description: "Submit an unvalidated locator proposal",
      },
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false);
    assert.deepEqual(proposedLocator(result.value), { strategy: "css", selector: "article" });
    const unavailable = await ctx.tools.execute({
      callId: ToolCallId("no-browser-tool"),
      name: "run_code",
      arguments: {
        code: "return await tools.exploreNavigate({ url: 'https://example.test' });",
        description: "Attempt unavailable browser access",
      },
      signal: new AbortController().signal,
    });
    assert.equal(unavailable.isError, true);
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

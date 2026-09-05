import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  CapabilityCompositionAgent,
  CapabilityCompositionRequest,
  CapabilityCompositionResult,
} from "../../agents/types.js";
import { analyzeAgentEvents, loadDshEvents } from "../../agents/dsh/session.js";
import { compositionProgressFromEvent } from "../../agents/dsh/composition-agent.js";
import { composeAndRun, inferTaskInputs } from "../index.js";

test("public composition API derives a complete request from natural-language input", async () => {
  let received: CapabilityCompositionRequest | undefined;
  const agent: CapabilityCompositionAgent = {
    async compose(request) {
      received = request;
      return completedResult();
    },
  };
  const result = await composeAndRun(agent, {
    task: "Search for mugs.",
    siteId: "shop.example.com",
    startUrl: "https://shop.example.com/",
    inputs: { query: "mug" },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(received?.inputs, { query: "mug" });
  assert.equal("needs" in (received as unknown as Record<string, unknown>), false);
  assert.equal("source" in (received as unknown as Record<string, unknown>), false);
  assert.equal(received?.budgets.maxActionCalls, 1000);
});

test("public composition API forwards one prompt's run controls", async () => {
  const controller = new AbortController();
  let received: Parameters<CapabilityCompositionAgent["compose"]>[1];
  const agent: CapabilityCompositionAgent = {
    async compose(_request, options) {
      received = options;
      return completedResult();
    },
  };
  const onProgress = () => undefined;
  await composeAndRun(agent, {
    task: "Collect quotes",
    siteId: "quotes.example.com",
    startUrl: "https://quotes.example.com/",
    signal: controller.signal,
    onProgress,
    runDirectory: "/tmp/run/prompts/0001",
    outputDirectory: "/tmp/run/output",
  });

  assert.equal(received?.signal, controller.signal);
  assert.equal(received?.onProgress, onProgress);
  assert.equal(received?.runDirectory, "/tmp/run/prompts/0001");
  assert.equal(received?.outputDirectory, "/tmp/run/output");
});

test("public composition API persists the complete result in the run directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-composition-result-"));
  try {
    const expected = completedResult();
    expected.runDirectory = directory;
    expected.execution = {
      success: true,
      value: { heading: "Example Domain" },
      logs: [],
      actionCalls: [],
    };
    const agent: CapabilityCompositionAgent = {
      async compose() {
        return expected;
      },
    };

    const actual = await composeAndRun(agent, {
      task: "Read the page heading",
      siteId: "example.com",
      startUrl: "https://example.com/",
    });

    assert.deepEqual(actual.execution?.value, { heading: "Example Domain" });
    assert.deepEqual(JSON.parse(await readFile(join(directory, "result.json"), "utf8")), actual);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("natural-language item counts become deterministic automation inputs", async () => {
  let received: CapabilityCompositionRequest | undefined;
  const agent: CapabilityCompositionAgent = {
    async compose(request) {
      received = request;
      return completedResult();
    },
  };
  await composeAndRun(agent, {
    task: "scrape the first 100 books",
    siteId: "books.example.com",
    startUrl: "https://books.example.com/",
  });

  assert.deepEqual(received?.inputs, { requestedCount: 100 });
  assert.deepEqual(inferTaskInputs("collect up to 2,500 records"), { requestedCount: 2500 });
  assert.deepEqual(inferTaskInputs("collect the books"), {});
});

test("composition events become compact tool progress", () => {
  assert.deepEqual(
    compositionProgressFromEvent({
      type: "tool/code-dispatch-start",
      data: { name: "prepareComposition", arguments: { intent: "extract quotes" } },
    }),
    {
      kind: "tool-call",
      message: "prepareComposition",
      detail: '{"intent":"extract quotes"}',
    },
  );
  assert.deepEqual(
    compositionProgressFromEvent({
      type: "tool/result",
      data: {
        message: {
          content: [
            {
              type: "tool-result",
              content: [{ type: "text", text: '{"status":"composed","automation":"quotes"}' }],
            },
          ],
        },
      },
    }),
    {
      kind: "tool-result",
      message: "run_code",
      detail: '{"status":"composed","automation":"quotes"}',
    },
  );
});

test("public composition API preserves typed refusal results", async () => {
  const agent: CapabilityCompositionAgent = {
    async compose() {
      const completed = completedResult();
      return {
        status: "refused",
        reason: "ambiguous capability match",
        reusedActions: completed.reusedActions,
        discoveredActions: completed.discoveredActions,
        actionsConsidered: completed.actionsConsidered,
        metrics: completed.metrics,
        trajectory: completed.trajectory,
      };
    },
  };
  const result = await composeAndRun(agent, {
    task: "Open it.",
    siteId: "shop.example.com",
    startUrl: "https://shop.example.com/",
  });
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "ambiguous capability match");
});

test("DSH event metrics count real requests, run_code, nested calls, and token usage", () => {
  const analyzed = analyzeAgentEvents(
    [
      { type: "request/header", data: { header: { tools: [{ name: "run_code" }] } } },
      {
        type: "assistant/message",
        data: {
          message: { source: { kind: "model" } },
          usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3 },
        },
      },
      { type: "tool/call", data: { name: "run_code", arguments: "{}" } },
      { type: "tool/code-dispatch", data: { name: "listCapabilities", arguments: "{}" } },
      {
        type: "tool/result",
        data: {
          message: {
            content: [
              {
                type: "tool-result",
                content: [{ type: "text", text: '{"status":"completed","automationId":"search"}' }],
              },
            ],
          },
        },
      },
    ],
    12.4,
  );
  assert.equal(analyzed.metrics.modelRequests, 1);
  assert.equal(analyzed.metrics.codeExecutions, 1);
  assert.equal(analyzed.metrics.nestedToolCalls, 1);
  assert.equal(analyzed.metrics.inputTokens, 14);
  assert.equal(analyzed.metrics.outputTokens, 7);
  assert.equal(analyzed.metrics.durationMs, 12);
  assert.deepEqual(analyzed.terminalValues.at(-1), {
    status: "completed",
    automationId: "search",
  });
  assert.equal(analyzed.nestedDiscoveryMs, 0);
});

test("DSH event timing separates nested action discovery", () => {
  const analyzed = analyzeAgentEvents(
    [
      {
        type: "tool/code-dispatch",
        data: {
          name: "prepareComposition",
          result: {
            value: {
              discovered: [
                {
                  discoveryMetrics: {
                    modelRequests: 2,
                    codeExecutions: 2,
                    nestedToolCalls: 7,
                    durationMs: 3210,
                  },
                },
              ],
            },
          },
        },
      },
    ],
    5000,
  );
  assert.equal(analyzed.nestedDiscoveryMs, 3210);
  assert.equal(analyzed.metrics.modelRequests, 2);
});

test("DSH event timing records the first meaningful browser action", () => {
  const analyzed = analyzeAgentEvents(
    [
      { type: "session", time: 1_000 },
      {
        type: "tool/code-dispatch-start",
        time: 1_080,
        data: { subCallId: "overview", name: "getOverview" },
      },
      {
        type: "tool/code-dispatch-start",
        time: 1_250,
        data: { subCallId: "fill", name: "exploreFill" },
      },
    ],
    500,
  );
  assert.equal(analyzed.metrics.firstActionMs, 250);
  assert.equal(analyzed.metrics.firstActionKind, "discovery");
});

test("DSH event timing projects nested discovery's first action onto composition", () => {
  const analyzed = analyzeAgentEvents(
    [
      { type: "session", time: 2_000 },
      {
        type: "tool/code-dispatch-start",
        time: 2_100,
        data: { subCallId: "prepare", name: "prepareComposition" },
      },
      {
        type: "tool/code-dispatch",
        time: 2_900,
        data: {
          subCallId: "prepare",
          name: "prepareComposition",
          result: {
            value: {
              discovered: [
                {
                  discoveryMetrics: {
                    modelRequests: 1,
                    codeExecutions: 1,
                    nestedToolCalls: 4,
                    durationMs: 700,
                    firstActionMs: 180,
                    firstBrowserActionMs: 40,
                  },
                },
              ],
            },
          },
        },
      },
    ],
    1_000,
  );
  assert.equal(analyzed.metrics.firstActionMs, 280);
  assert.equal(analyzed.metrics.firstActionKind, "discovery");
  assert.equal(analyzed.metrics.firstBrowserActionMs, 140);
  assert.equal(analyzed.metrics.firstBrowserActionKind, "discovery-navigation");
});

function completedResult(): CapabilityCompositionResult {
  return {
    status: "completed",
    automation: {
      id: "search-mugs",
      siteId: "shop.example.com",
      source:
        "export default defineAutomation(async (ctx, input) => ctx.actions.searchProducts({ query: input.query }));",
      version: 1,
    },
    reusedActions: ["searchProducts"],
    discoveredActions: [],
    actionsConsidered: [],
    execution: { success: true, logs: [], actionCalls: [] },
    metrics: {
      modelRequests: 1,
      codeExecutions: 1,
      nestedToolCalls: 4,
      durationMs: 10,
      repairSucceeded: true,
      actionsConsidered: 1,
      actionsReused: 1,
      actionsDiscovered: 0,
      unnecessaryRediscoveries: 0,
      generatedAutomationLines: 1,
      generatedAutomationNodes: 1,
    },
    trajectory: [],
  };
}

test("recursive session metrics count discovery logs once even when summaries are returned", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-metrics-"));
  const child = join(root, "discovery", "action", "session");
  const request = [
    { type: "request/header", data: {} },
    {
      type: "assistant/message",
      data: { message: { source: { kind: "model" } }, usage: { inputTokens: 11, outputTokens: 7 } },
    },
    { type: "tool/call", data: { name: "run_code", arguments: "{}" } },
  ];
  try {
    await mkdir(child, { recursive: true });
    await writeFile(
      join(child, "session.jsonl"),
      [...request, { type: "tool/code-dispatch", data: { name: "submitAction", result: {} } }]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    await writeFile(
      join(root, "session.jsonl"),
      [
        ...request,
        {
          type: "tool/code-dispatch",
          data: {
            name: "prepareComposition",
            result: {
              value: {
                discovered: [
                  {
                    discoveryMetrics: {
                      modelRequests: 1,
                      codeExecutions: 1,
                      nestedToolCalls: 1,
                      inputTokens: 11,
                      outputTokens: 7,
                      durationMs: 100,
                    },
                  },
                ],
              },
            },
          },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    const analyzed = analyzeAgentEvents(await loadDshEvents(root), 200);
    assert.equal(analyzed.metrics.modelRequests, 2);
    assert.equal(analyzed.metrics.codeExecutions, 2);
    assert.equal(analyzed.metrics.nestedToolCalls, 2);
    assert.equal(analyzed.metrics.inputTokens, 22);
    assert.equal(analyzed.metrics.outputTokens, 14);
    assert.equal(analyzed.nestedDiscoveryMs, 100);
    assert.ok(analyzed.trajectory.some((t) => t.name === "submitAction"));
    const standalone = analyzeAgentEvents(
      await loadDshEvents(join(root, "discovery", "action")),
      100,
    );
    assert.equal(standalone.metrics.modelRequests, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

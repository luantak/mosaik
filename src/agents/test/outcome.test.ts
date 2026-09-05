import assert from "node:assert/strict";
import test from "node:test";
import { completeTask, parseTaskOutcome, type OutcomeReview } from "../outcome.js";
import type { CapabilityCompositionRequest, CapabilityCompositionResult } from "../types.js";
import {
  DEFAULT_COMPOSITION_BUDGETS,
  DEFAULT_COMPOSITION_SAFETY,
} from "../../composition/index.js";

const request: CapabilityCompositionRequest = {
  task: "Explain the API using the documentation",
  siteId: "example.com",
  startUrl: "https://example.com",
  inputs: {},
  budgets: DEFAULT_COMPOSITION_BUDGETS,
  safety: DEFAULT_COMPOSITION_SAFETY,
};
const metrics = {
  modelRequests: 1,
  codeExecutions: 1,
  nestedToolCalls: 1,
  durationMs: 10,
  repairSucceeded: false,
};
function execution(value: unknown = { pages: [] }): CapabilityCompositionResult {
  return {
    status: "completed",
    reusedActions: [],
    discoveredActions: [],
    actionsConsidered: [],
    execution: { success: true, value, logs: [], actionCalls: [] },
    metrics: {
      ...metrics,
      actionsConsidered: 0,
      actionsReused: 0,
      actionsDiscovered: 0,
      unnecessaryRediscoveries: 0,
      generatedAutomationLines: 0,
      generatedAutomationNodes: 0,
    },
    trajectory: [],
  };
}
const incomplete: OutcomeReview = {
  outcome: {
    status: "incomplete",
    reason: "No documentation was collected. Inspect the candidate links before filtering.",
  },
  metrics,
  trajectory: [],
};
const complete: OutcomeReview = {
  outcome: {
    status: "complete",
    answer: "Use the documented endpoint. Source: https://example.com/api",
  },
  metrics,
  trajectory: [],
};

test("empty evidence is incomplete even though the automation succeeded; recovery is bounded", async () => {
  let calls = 0;
  const result = await completeTask(
    request,
    {},
    async (_request, attempt, feedback) => {
      calls++;
      assert.equal(attempt, calls - 1);
      if (attempt === 1) assert.match(feedback!, /No documentation/);
      return execution();
    },
    async () => incomplete,
  );
  assert.equal(calls, 2);
  assert.equal(result.status, "failed");
  assert.equal(result.execution?.success, true);
  assert.match(result.reason!, /No documentation/);
  assert.equal(result.attempts?.length, 2);
});

test("recovery receives action results, shares budgets, and returns a grounded answer", async () => {
  const result = await completeTask(
    request,
    {},
    async (remaining, attempt, feedback) => {
      if (attempt === 1) {
        assert.equal(remaining.budgets.maxModelRequests, request.budgets.maxModelRequests - 2);
        assert.match(feedback!, /candidate-link/);
      }
      const value = execution(
        attempt === 0 ? { pages: [] } : { pages: [{ content: "Endpoint details" }] },
      );
      value.execution!.actionResults = [{ name: "collectLinks", result: ["candidate-link"] }];
      return value;
    },
    async (_request, _result, attempt) => (attempt === 0 ? incomplete : complete),
  );
  assert.equal(result.status, "completed");
  assert.equal(result.answer, complete.outcome.answer);
  assert.equal(result.metrics.modelRequests, 4);
  assert.equal(result.attempts?.length, 2);
});

test("valid no-match results may complete without recovery", async () => {
  let calls = 0;
  const result = await completeTask(
    { ...request, task: "List matching records" },
    {},
    async () => {
      calls++;
      return execution([]);
    },
    async () => ({
      ...complete,
      outcome: { status: "complete", answer: "No matching records were found." },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(result.status, "completed");
});

test("unknown action safety prevents automatic replay", async () => {
  let calls = 0;
  const result = await completeTask(
    request,
    {},
    async () => {
      calls++;
      const value = execution();
      value.execution!.actionCalls = [{ name: "send", args: {} }];
      return value;
    },
    async () => incomplete,
  );
  assert.equal(calls, 1);
  assert.equal(result.status, "failed");
});

test("exhausted budget leaves execution unverified instead of reporting completion", async () => {
  const result = await completeTask(
    { ...request, budgets: { ...request.budgets, maxModelRequests: 1 } },
    {},
    async () => execution(),
    async () => {
      throw new Error("Must not call reviewer");
    },
  );
  assert.equal(result.status, "failed");
  assert.match(result.reason!, /budget was exhausted/);
});

test("review failures preserve execution evidence and do not retry", async () => {
  let calls = 0;
  const result = await completeTask(
    request,
    {},
    async () => {
      calls++;
      return execution();
    },
    async () => {
      throw new Error("Provider unavailable");
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.execution?.success, true);
  assert.equal(result.status, "failed");
  assert.match(result.reason!, /Provider unavailable/);
});

test("cancellation propagates without starting execution", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    completeTask(
      request,
      { signal: controller.signal },
      async () => {
        throw new Error("Must not execute");
      },
      async () => complete,
    ),
    { name: "AbortError" },
  );
});

test("outcome contract requires an answer or a missing-evidence reason", () => {
  assert.equal(parseTaskOutcome({ status: "complete", answer: " " }), undefined);
  assert.equal(parseTaskOutcome({ status: "incomplete" }), undefined);
  assert.deepEqual(parseTaskOutcome({ status: "complete", answer: " Done " }), {
    status: "complete",
    answer: "Done",
  });
});

test("browser navigation may recover but external side effects are not replayed", async () => {
  for (const safety of ["browser-local", "external-side-effect"] as const) {
    let calls = 0;
    await completeTask(
      request,
      {},
      async () => {
        calls++;
        const result = execution();
        result.actionsConsidered = [
          {
            id: "example.action",
            siteId: "example.com",
            name: "action",
            description: "An action",
            contexts: [],
            signature: "action()",
            inputs: {},
            outputs: {},
            safety,
            version: 1,
            interfaceVersion: 1,
            verification: "verified",
            verificationBasis: "legacy-execution",
          },
        ];
        result.execution!.actionCalls = [{ name: "action", args: {} }];
        return result;
      },
      async () => incomplete,
    );
    assert.equal(calls, safety === "browser-local" ? 2 : 1);
  }
});

test("incomplete outcomes preserve supported partial answers", async () => {
  const outcome = parseTaskOutcome({
    status: "incomplete",
    reason: "Missing endpoint details",
    answer: "Authentication is documented at https://example.com/api",
  })!;
  const result = await completeTask(
    request,
    {},
    async () => execution(),
    async () => ({ ...incomplete, outcome }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.answer, outcome.answer);
  assert.equal(result.reason, "Missing endpoint details");
});

test("recovery follows new evidence through an overview to a reference page", async () => {
  let calls = 0;
  const result = await completeTask(
    request,
    {},
    async (_remaining, attempt, feedback) => {
      calls++;
      if (attempt === 2) assert.match(feedback!, /reference#create/);
      const value = execution({
        content: ["Navigation only", "API overview", "POST /agents with prompt"][attempt],
      });
      value.execution!.pageNavigation = {
        url: `https://example.com/page-${attempt}`,
        title: "Documentation",
        links: [{ href: "https://example.com/reference#create", title: "Create an agent" }],
        truncated: false,
      };
      return value;
    },
    async (_request, _result, attempt) => (attempt < 2 ? incomplete : complete),
  );
  assert.equal(calls, 3);
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.modelRequests, 6);
});

test("changing evidence still obeys the recovery attempt limit", async () => {
  let calls = 0;
  const result = await completeTask(
    request,
    {},
    async () => execution({ page: ++calls }),
    async () => incomplete,
  );
  assert.equal(calls, 4);
  assert.equal(result.status, "failed");
});

test("incomplete discovery evidence does not trigger an automatic automation replay", async () => {
  let executions = 0;
  const result = await completeTask(
    request,
    {},
    async () => {
      executions++;
      const result = execution();
      result.completionMode = "discovery";
      result.execution!.origin = "discovery";
      result.execution!.discoveryObservations = [{ name: "readReference", outputs: {} }];
      return result;
    },
    async () => incomplete,
  );
  assert.equal(executions, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.outcome?.status, "incomplete");
});

test("incomplete read-only discovery evidence can recover", async () => {
  let executions = 0;
  const result = await completeTask(
    request,
    {},
    async (_remaining, attempt, feedback) => {
      if (attempt === 1)
        assert.deepEqual(JSON.parse(feedback!).attemptedActions, ["readReference"]);
      executions++;
      const result = execution();
      result.actionsConsidered = [
        {
          id: "example.read-reference",
          siteId: "example.com",
          name: "readReference",
          description: "Read a reference",
          signature: "readReference()",
          inputs: {},
          outputs: {},
          safety: "read-only",
          version: 1,
          interfaceVersion: 1,
          verification: "verified",
        },
      ];
      result.completionMode = "discovery";
      result.execution!.origin = "discovery";
      result.execution!.discoveryObservations = [{ name: "readReference", outputs: {} }];
      return result;
    },
    async (_request, _result, attempt) => (attempt === 0 ? incomplete : complete),
  );
  assert.equal(executions, 2);
  assert.equal(result.status, "completed");
});

test("an incomplete observed mutation is reviewed without replaying it", async () => {
  let calls = 0;
  const result = await completeTask(
    request,
    {},
    async () => {
      calls++;
      const result = execution();
      result.execution!.origin = "discovery";
      result.execution!.discoveryObservations = [{ name: "createItem", performedClicks: [] }];
      result.actionsConsidered = [
        {
          id: "site.create",
          siteId: "example.com",
          name: "createItem",
          description: "Create an item",
          signature: "createItem()",
          inputs: {},
          outputs: {},
          safety: "browser-local",
          version: 1,
          interfaceVersion: 1,
          verification: "unverified",
        },
      ];
      return result;
    },
    async () => incomplete,
  );
  assert.equal(calls, 1);
  assert.equal(result.outcome?.status, "incomplete");
});

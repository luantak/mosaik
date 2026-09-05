import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openFileRepository } from "../../../persist/repository.js";
import { createMemoryRegistry, defineAction } from "../../../capabilities/index.js";
import {
  readReusableAutomation,
  rememberReusableAutomation,
  forgetReusableAutomation,
  automationReuseKey,
} from "../automation-reuse.js";
import type { CapabilityCompositionRequest } from "../../types.js";
import type { ComposedAutomation } from "../../../automations/types.js";

const request: CapabilityCompositionRequest = {
  task: "Read items",
  siteId: "example.com",
  startUrl: "https://example.com/",
  inputs: { count: 10, filter: "all" },
  safety: { allowedActionSafety: ["read-only"], allowExternalSideEffects: false },
  budgets: {
    maxModelRequests: 10,
    maxRunCodeExecutions: 10,
    maxNestedToolCalls: 50,
    maxActionCalls: 100,
    executionTimeoutMs: 10000,
  },
};
test("reuse keys require the same request but ignore object key order and runtime budgets", () => {
  assert.equal(
    automationReuseKey(request),
    automationReuseKey({
      ...request,
      inputs: { filter: "all", count: 10 },
      budgets: { ...request.budgets, maxActionCalls: 50 },
    }),
  );
  for (const changed of [
    { ...request, task: "Delete items" },
    { ...request, startUrl: "https://example.com/other" },
    { ...request, siteId: "other.com" },
    { ...request, inputs: { count: 11, filter: "all" } },
    { ...request, safety: { ...request.safety, allowExternalSideEffects: true } },
    { ...request, automationId: "other" },
  ])
    assert.notEqual(automationReuseKey(request), automationReuseKey(changed));
});
test("successful automation reuse invalidates changed source, actions and nested automations", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-reuse-"));
  try {
    const disk = openFileRepository(root);
    const registry = createMemoryRegistry();
    const store = { ...disk, siteActions: registry };
    const action = defineAction({
      id: "read",
      siteId: request.siteId,
      name: "readItems",
      description: "Read items",
      inputs: {},
      outputs: {},
      safety: "read-only",
      steps: [
        {
          id: "read",
          type: "click",
          locator: { strategy: "css", selector: "button" },
          safety: "read-only",
        },
      ],
    });
    await registry.save(action);
    const child: ComposedAutomation = {
      id: "child",
      siteId: request.siteId,
      version: 1,
      source: "export default defineAutomation(async (ctx) => ctx.actions.readItems({}));",
    };
    let automation: ComposedAutomation = {
      id: "parent",
      siteId: request.siteId,
      version: 1,
      source:
        'import child from "./child.js";\nexport default defineAutomation(async (ctx,input) => child(ctx,input));',
    };
    await store.saveAutomation(child);
    await store.saveAutomation(automation);
    automation = (await store.getAutomation(request.siteId, automation.id))!;
    assert.equal(await readReusableAutomation(store, request), undefined);
    await rememberReusableAutomation(store, request, automation);
    assert.equal((await readReusableAutomation(store, request))?.id, "parent");
    await registry.save({ ...action, verification: "verified" });
    assert.equal((await readReusableAutomation(store, request))?.id, "parent");
    await registry.save({ ...action, description: "Changed meaning" });
    assert.equal(await readReusableAutomation(store, request), undefined);
    await registry.save(action);
    await store.saveAutomation({
      ...child,
      source: child.source.replace("readItems({})", "readItems({changed:true})"),
    });
    assert.equal(await readReusableAutomation(store, request), undefined);
    await store.saveAutomation(child);
    await store.saveAutomation({ ...automation, source: automation.source + "\n// edited" });
    assert.equal(await readReusableAutomation(store, request), undefined);
    await store.saveAutomation(automation);
    await rememberReusableAutomation(store, request, automation);
    await forgetReusableAutomation(store, request);
    assert.equal(await readReusableAutomation(store, request), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cached composition executes live browser actions with no model requests", async () => {
  const { startFixtureServer, withBrowser } = await import("../../../runtime/index.js");
  const { DshCapabilityCompositionAgent } = await import("../composition-agent.js");
  const fixture = await startFixtureServer({ "/": { html: "<h1>Fresh live title</h1>" } });
  const root = await mkdtemp(join(tmpdir(), "mosaik-reuse-browser-"));
  try {
    await withBrowser(async (browser) => {
      const store = openFileRepository(root);
      const liveRequest = { ...request, siteId: new URL(fixture.url).host, startUrl: fixture.url };
      const action = defineAction({
        id: "read-title",
        siteId: liveRequest.siteId,
        name: "readTitle",
        description: "Read title",
        inputs: {},
        outputs: { title: { type: "string" } },
        safety: "read-only",
        steps: [
          {
            id: "title",
            type: "extract-text",
            locator: { strategy: "css", selector: "h1" },
            output: "title",
            safety: "read-only",
          },
        ],
      });
      await store.siteActions.save(action);
      await store.saveAutomation({
        id: "read-title",
        siteId: liveRequest.siteId,
        version: 1,
        source:
          'import { readTitle } from "../actions/readTitle.js";\nexport default defineAutomation(async()=> await readTitle({}));',
      });
      const automation = (await store.getAutomation(liveRequest.siteId, "read-title"))!;
      await rememberReusableAutomation(store, liveRequest, automation);
      const agent = new DshCapabilityCompositionAgent(browser, store, root, root);
      const attempt = agent as unknown as {
        composeAttempt(
          request: CapabilityCompositionRequest,
          options: import("../../types.js").CompositionRunOptions,
        ): Promise<import("../../types.js").CapabilityCompositionResult>;
      };
      for (let i = 0; i < 2; i++) {
        assert.ok(
          await readReusableAutomation(store, liveRequest),
          "cache remains valid before execution",
        );
        const result = await attempt.composeAttempt(liveRequest, {
          runDirectory: join(root, "runs", String(i)),
          outputDirectory: join(root, "output"),
        });
        assert.equal(result.status, "completed", result.reason);
        assert.deepEqual(result.execution?.value, { title: "Fresh live title" });
        assert.equal(result.metrics.modelRequests, 0);
        assert.equal(result.metrics.timings?.outerCompositionMs, 0);
        assert.equal(result.discoveredActions.length, 0);
      }
      assert.ok(fixture.requestCount("/") >= 2, "reruns fetch live data");
    });
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

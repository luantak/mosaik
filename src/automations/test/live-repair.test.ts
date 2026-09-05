import assert from "node:assert/strict";
import { test } from "vitest";
import { chromium } from "playwright";
import { defineAction, createMemoryRegistry } from "../../capabilities/index.js";
import type { RepairAgent } from "../../agents/types.js";
import { startFixtureServer } from "../../runtime/index.js";
import { runAutomation } from "../run.js";
import { RepairFlightCoordinator } from "../repair-flight.js";

const html = `<button id="open" onclick="this.remove();document.querySelector('section').hidden=false;document.querySelector('#count').textContent=String(++window.opens)">Open</button><span id="count">0</span><section hidden><label>New name<input></label></section><script>window.opens=0</script>`;
const metrics = {
  modelRequests: 1,
  codeExecutions: 0,
  nestedToolCalls: 0,
  durationMs: 1,
  repairSucceeded: false,
};

test("late repair retains the active editor, extracted outputs and original automation continuation", async () => {
  const fixture = await startFixtureServer({ "/": { html } });
  const browser = await chromium.launch({ headless: true });
  try {
    const action = defineAction({
      id: "customer.edit",
      siteId: new URL(fixture.url).host,
      name: "fillCustomer",
      description: "Open and edit the customer",
      inputs: { name: { type: "string" } },
      outputs: { opens: { type: "number" } },
      safety: "browser-local",
      steps: [
        {
          id: "open",
          type: "click",
          safety: "browser-local",
          locator: { strategy: "css", selector: "#open" },
        },
        {
          id: "count",
          type: "extract-text",
          safety: "read-only",
          locator: { strategy: "css", selector: "#count" },
          output: "opens",
        },
        {
          id: "name",
          type: "fill",
          safety: "browser-local",
          locator: { strategy: "label", label: "Old name" },
          value: { kind: "input", key: "name" },
        },
      ],
      completion: { kind: "count", locator: { strategy: "css", selector: "#open" }, count: 0 },
    });
    let calls = 0;
    const agent: RepairAgent = {
      async generateRepair(request) {
        calls += 1;
        assert.equal(request.mode, "live-continuation");
        assert.equal(request.failure.stepId, "name");
        assert.equal(request.automation.actions[0]!.steps[0]!.id, "open");
        return {
          success: true,
          validated: false,
          patches: [
            {
              type: "replace-locator",
              stepId: "name",
              locator: { strategy: "label", label: "New name" },
            },
          ],
          modelResponse: "",
          metrics,
          trajectory: [],
        };
      },
    };
    const registry = createMemoryRegistry([action]);
    const result = await runAutomation(
      browser,
      {
        id: "edit",
        siteId: action.siteId,
        version: 1,
        actionIds: [action.id],
        source:
          'export default defineAutomation(async (ctx) => { const result = await ctx.actions.fillCustomer({ name: "Ada" }); return { ...result, continued: true }; });',
      },
      { registry, startUrl: fixture.url, stepTimeoutMs: 1000, agent },
    );
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.value, { opens: 1, continued: true });
    assert.equal(result.actionCalls.length, 1);
    assert.equal(calls, 1);
    assert.equal((await registry.get(action.id))!.version, 2);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("shared repair shares patches and each caller executes its own remaining steps", async () => {
  const fixture = await startFixtureServer({
    "/": { html: "<label>New name<input></label><p>ok</p>" },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const action = defineAction({
      id: "customer.name",
      siteId: new URL(fixture.url).host,
      name: "fillName",
      description: "Fill the customer name",
      safety: "browser-local",
      steps: [
        {
          id: "name",
          type: "fill",
          safety: "browser-local",
          locator: { strategy: "label", label: "Old name" },
          value: "Ada",
        },
      ],
    });
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const agent: RepairAgent = {
      async generateRepair() {
        calls += 1;
        return {
          success: true,
          validated: false,
          patches: [
            {
              type: "replace-locator",
              stepId: "name",
              locator: { strategy: "label", label: "New name" },
            },
          ],
          modelResponse: "",
          metrics,
          trajectory: [],
        };
      },
    };
    const registry = createMemoryRegistry([action]);
    const flights = new RepairFlightCoordinator();
    const automation = {
      id: "name",
      siteId: action.siteId,
      version: 1,
      actionIds: [action.id],
      source:
        'export default defineAutomation(async (ctx) => { await ctx.actions.fillName(); return "continued"; });',
    };
    const results = await Promise.all(
      [1, 2].map(() =>
        runAutomation(browser, automation, {
          registry,
          agent,
          startUrl: fixture.url,
          stepTimeoutMs: 1000,
          repairFlights: flights,
          beforeSharedRepair: async () => {
            if (++entered === 2) release();
            await barrier;
          },
        }),
      ),
    );
    assert.ok(
      results.every((result) => result.success),
      JSON.stringify(results),
    );
    assert.equal(calls, 1);
    assert.ok(results.every((result) => result.actionCalls.length === 1));
    assert.equal((await registry.get(action.id))!.version, 2);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("unsupported state adds a disjoint implementation without replacing the old one", async () => {
  const fixture = await startFixtureServer({
    "/": { html: '<body data-layout="new"><button class="new">Save</button></body>' },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const action = defineAction({
      id: "editor.save",
      siteId: new URL(fixture.url).host,
      name: "saveEditor",
      description: "Save the editor",
      safety: "browser-local",
      precondition: {
        kind: "attribute",
        locator: { strategy: "css", selector: "body" },
        name: "data-layout",
        value: "old",
      },
      completion: { kind: "count", locator: { strategy: "css", selector: "button" }, count: 1 },
      steps: [
        {
          id: "save",
          type: "click",
          safety: "browser-local",
          locator: { strategy: "css", selector: ".old" },
        },
      ],
    });
    const registry = createMemoryRegistry([action]);
    const agent: RepairAgent = {
      async generateRepair(request) {
        assert.equal(request.failure.error.type, "unsupported-state");
        return {
          success: true,
          validated: false,
          statePatch: {
            type: "add-implementation",
            implementation: {
              ...action.implementation,
              id: "new",
              precondition: {
                kind: "attribute",
                locator: { strategy: "css", selector: "body" },
                name: "data-layout",
                value: "new",
              },
              steps: [
                {
                  ...action.implementation.steps[0]!,
                  locator: { strategy: "css", selector: ".new" },
                },
              ],
            },
          },
          modelResponse: "",
          metrics,
          trajectory: [],
        };
      },
    };
    const automation = {
      id: "save",
      siteId: action.siteId,
      version: 1,
      actionIds: [action.id],
      source:
        'export default defineAutomation(async ctx => { await ctx.actions.saveEditor(); return "saved"; });',
    };
    const first = await runAutomation(browser, automation, {
      registry,
      agent,
      startUrl: fixture.url,
      stepTimeoutMs: 1000,
    });
    assert.equal(first.success, true, first.error);
    assert.equal((await registry.get(action.id))!.implementations?.length, 2);
    await fixture.update("/", {
      html: '<body data-layout="old"><button class="old">Save</button></body>',
    });
    const second = await runAutomation(browser, automation, {
      registry,
      startUrl: fixture.url,
      stepTimeoutMs: 1000,
    });
    assert.equal(second.success, true, second.error);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("known historical regressions block shared replacement before another fill", async () => {
  const fixture = await startFixtureServer({
    "/": { html: '<input class="new" value="unchanged">' },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const action = defineAction({
      id: "name.fill",
      siteId: new URL(fixture.url).host,
      name: "fillName",
      description: "Fill the name",
      safety: "browser-local",
      steps: [
        {
          id: "fill",
          type: "fill",
          safety: "browser-local",
          locator: { strategy: "css", selector: ".old" },
          value: "Ada",
        },
      ],
    });
    const registry = createMemoryRegistry([action]);
    const { contractFingerprint } = await import("../../evidence/capture.js");
    const dom = { html: '<input class="old">', complete: true, redacted: false, unsupported: [] };
    await registry.cases!.save({
      schemaVersion: 1,
      id: "old-case",
      siteId: action.siteId,
      actionId: action.id,
      implementationId: "default",
      contractVersion: 1,
      contractFingerprint: contractFingerprint(action),
      implementationVersion: 1,
      runId: "asserted-fixture",
      capturedAt: Date.now(),
      context: { tab: "fixture", frame: "main" },
      inputs: {},
      inputsComplete: true,
      before: dom,
      after: dom,
      observations: { precondition: null, completion: null },
      steps: [{ stepId: "fill", dom, matches: 1, tags: ["input"] }],
      output: {},
      expectations: [],
      fingerprint: "old-layout",
    });
    const agent: RepairAgent = {
      async generateRepair() {
        return {
          success: true,
          validated: false,
          patches: [
            {
              type: "replace-locator",
              stepId: "fill",
              locator: { strategy: "css", selector: ".new" },
            },
          ],
          modelResponse: "",
          metrics,
          trajectory: [],
        };
      },
    };
    const result = await runAutomation(
      browser,
      {
        id: "fill",
        siteId: action.siteId,
        version: 1,
        actionIds: [action.id],
        source: "export default defineAutomation(async ctx => { await ctx.actions.fillName(); });",
      },
      { registry, agent, startUrl: fixture.url, stepTimeoutMs: 1000 },
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /regression/);
    assert.ok(result.coverage?.some((check) => check.status === "fail"));
    assert.equal((await registry.get(action.id))!.version, 1);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

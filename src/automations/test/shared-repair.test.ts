import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RepairAgent, RepairProposal } from "../../agents/types.js";
import {
  applyActionPatches,
  array,
  createMemoryRegistry,
  defineAction,
  productRef,
  string,
  type SiteActionDefinition,
} from "../../capabilities/index.js";
import type { RepairRequest } from "../../core/index.js";
import {
  click,
  extractList,
  fill,
  hrefField,
  inputRef,
  label,
  role,
  testId,
  textField,
} from "../../core/index.js";
import { shopPlaceOrder } from "../../fixtures/shop.js";
import { openFileRepository } from "../../persist/repository.js";
import { startFixtureServer, withBrowser } from "../../runtime/index.js";
import { mayValidateStepLive } from "../../repair/policy.js";
import { RepairFlightCoordinator } from "../repair-flight.js";
import { formatDependencies, automationDependencies, runAutomation } from "../index.js";
import type { ComposedAutomation, AutomationExecutionResult } from "../types.js";

const CALLERS = 10;

test("concurrent callers repair one shared action version once", { timeout: 120_000 }, async () => {
  const fixture = await startFixtureServer({ "/": { html: catalogHtml("Find") } });
  await withTempRoot(async (root) => {
    try {
      await withBrowser(async (browser) => {
        const siteId = new URL(fixture.url).host;
        const store = openFileRepository(root);
        const search = catalogSearch(siteId);
        await store.siteActions.save(search);
        const source = searchAutomation();
        const automation = searchCaller(siteId, source, search);
        await store.saveAutomation(automation);

        const wave = createBarrier(CALLERS);
        const agent = countingAgent(() => findPatch(1));
        const flights = new RepairFlightCoordinator();
        const results = await Promise.all(
          Array.from({ length: CALLERS }, (_, index) =>
            runAutomation(
              browser,
              { ...automation, id: `search-${index}` },
              {
                registry: store.siteActions,
                startUrl: fixture.url,
                input: { query: "mug" },
                stepTimeoutMs: 300,
                agent: agent.agent,
                repairFlights: flights,
                beforeSharedRepair: () => wave.enter(),
              },
            ),
          ),
        );

        const metrics = sumCoordination(results);
        assert.equal(
          results.every((result) => result.success),
          true,
          firstError(results),
        );
        assert.equal(agent.calls, 1);
        assert.equal(metrics.repairOwners, 1);
        assert.equal(metrics.repairsCommitted, 1);
        assert.equal(metrics.repairsDeduplicated, CALLERS - 1);
        assert.equal(metrics.callersRecoveredFromSharedRepair, CALLERS - 1);
        assert.equal(metrics.staleRepairConflicts, 0);
        assert.equal(
          results.filter((result) => result.recovery?.repairPerformedByCaller).length,
          1,
        );
        assert.equal(
          results.every((result) => result.automation?.source === source),
          true,
        );
        assert.equal(
          results.every((result) => result.repairedAction?.toVersion === 2),
          true,
        );

        const current = await store.siteActions.get(search.id);
        assert.ok(current);
        assertInterfaceUnchanged(search, current);
        assert.equal(current.version, 2);
        assertLocatorName(current, "submit", "Find");

        const fresh = openFileRepository(root);
        const persisted = await fresh.siteActions.get(search.id);
        assert.equal(persisted?.version, 2);
        const files = await readdir(join(root, "sites", encodeURIComponent(siteId), "actions"));
        assert.equal(files.filter((name) => name.endsWith(".json")).length, 1);
        assert.equal(
          files.some((name) => name.endsWith(".tmp")),
          false,
        );
        const loaded = await fresh.getAutomation(siteId, automation.id);
        assert.equal(loaded?.source.trim(), source.trim());
        assert.deepEqual(formatDependencies(loaded?.dependencies ?? []), [
          "shop.search-products@1",
        ]);
        const reused = await runAutomation(browser, loaded ?? automation, {
          registry: fresh.siteActions,
          startUrl: fixture.url,
          input: { query: "mug" },
          stepTimeoutMs: 300,
        });
        assert.equal(reused.success, true, reused.error);
        assert.equal(reused.retried, undefined);
        assert.equal(reused.automation?.source.trim(), source.trim());

        await fixture.update("/", { html: catalogHtml("Look") });
        const laterAgent = countingAgent(() => lookPatch(2));
        const laterFlights = new RepairFlightCoordinator();
        const laterJoin = createBarrier(5);
        const later = await Promise.all(
          Array.from({ length: 5 }, (_, index) =>
            runAutomation(
              browser,
              { ...automation, id: `later-${index}` },
              {
                registry: store.siteActions,
                startUrl: fixture.url,
                input: { query: "mug" },
                stepTimeoutMs: 300,
                agent: laterAgent.agent,
                repairFlights: laterFlights,
                beforeSharedRepair: () => laterJoin.enter(),
              },
            ),
          ),
        );
        assert.equal(
          later.every((result) => result.success),
          true,
          firstError(later),
        );
        assert.equal(laterAgent.calls, 1);
        assert.equal(sumCoordination(later).repairsCommitted, 1);
        assert.equal((await store.siteActions.get(search.id))?.version, 3);
        assertLocatorName((await store.siteActions.get(search.id))!, "submit", "Look");
      });
    } finally {
      await fixture.close();
    }
  });
});

test(
  "a stale in-flight repair cannot overwrite a newer canonical action",
  { timeout: 60_000 },
  async () => {
    const fixture = await startFixtureServer({ "/": { html: catalogHtml("Find") } });
    await withTempRoot(async (root) => {
      try {
        await withBrowser(async (browser) => {
          const siteId = new URL(fixture.url).host;
          const store = openFileRepository(root);
          const search = catalogSearch(siteId);
          await store.siteActions.save(search);
          const automation = searchCaller(siteId, searchAutomation(), search);
          const advanced = applyActionPatches(search, [
            {
              type: "replace-locator",
              stepId: "submit",
              locator: { strategy: "role", role: "button", name: "Find" },
            },
          ]);
          const agent = countingAgent(async () => {
            await store.siteActions.save(advanced);
            return findPatch(1);
          });
          const result = await runAutomation(browser, automation, {
            registry: store.siteActions,
            startUrl: fixture.url,
            input: { query: "mug" },
            stepTimeoutMs: 300,
            agent: agent.agent,
            repairFlights: new RepairFlightCoordinator(),
          });
          assert.equal(result.success, true, result.error);
          assert.equal(result.retried, true);
          assert.equal(result.repairCoordination?.staleRepairConflicts, 1);
          assert.equal(result.repairCoordination?.repairsCommitted, 0);
          assert.equal(result.recovery?.repairPerformedByCaller, false);
          assert.equal(result.automation?.source, automation.source);
          const current = await store.siteActions.get(search.id);
          assert.equal(current?.version, 2);
          assertLocatorName(current!, "submit", "Find");
        });
      } finally {
        await fixture.close();
      }
    });
  },
);

test(
  "a refused repair is shared and does not write a new action version",
  { timeout: 90_000 },
  async () => {
    const fixture = await startFixtureServer({ "/": { html: catalogHtml("Find") } });
    await withTempRoot(async (root) => {
      try {
        await withBrowser(async (browser) => {
          const siteId = new URL(fixture.url).host;
          const store = openFileRepository(root);
          const search = catalogSearch(siteId);
          await store.siteActions.save(search);
          const automation = searchCaller(siteId, searchAutomation(), search);
          const agent = countingAgent(() => ({
            success: false,
            validated: false,
            reason: "no safe locator",
          }));
          const wave = createBarrier(CALLERS);
          const flights = new RepairFlightCoordinator();
          const results = await Promise.all(
            Array.from({ length: CALLERS }, (_, index) =>
              runAutomation(
                browser,
                { ...automation, id: `fail-${index}` },
                {
                  registry: store.siteActions,
                  startUrl: fixture.url,
                  input: { query: "mug" },
                  stepTimeoutMs: 300,
                  agent: agent.agent,
                  repairFlights: flights,
                  beforeSharedRepair: () => wave.enter(),
                },
              ),
            ),
          );
          assert.equal(agent.calls, 1);
          assert.equal(
            results.every((result) => result.success === false),
            true,
          );
          assert.equal(
            results.every((result) => result.retried === undefined),
            true,
          );
          assert.equal(sumCoordination(results).repairsCommitted, 0);
          assert.equal(sumCoordination(results).repairsDeduplicated, CALLERS - 1);
          assert.equal((await store.siteActions.get(search.id))?.version, 1);

          const later = countingAgent(() => findPatch(1));
          const recovered = await runAutomation(browser, automation, {
            registry: store.siteActions,
            startUrl: fixture.url,
            input: { query: "mug" },
            stepTimeoutMs: 300,
            agent: later.agent,
            repairFlights: new RepairFlightCoordinator(),
          });
          assert.equal(recovered.success, true, recovered.error);
          assert.equal(later.calls, 1);
          assert.equal((await store.siteActions.get(search.id))?.version, 2);
        });
      } finally {
        await fixture.close();
      }
    });
  },
);

test("concurrent external-side-effect repairs stay propose-only", { timeout: 90_000 }, async () => {
  const fixture = await startFixtureServer({
    "/": { html: placeOrderHtml("Submit order") },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const place = defineAction({
        id: "shop.place-order",
        siteId,
        name: "placeOrder",
        description: "Place the current order",
        safety: "external-side-effect",
        steps: shopPlaceOrder(fixture.url).actions[0]!.steps.filter(
          (step) => step.type === "click",
        ),
      });
      const registry = createMemoryRegistry([place]);
      const source = `
export default defineAutomation(async (ctx) => {
  await ctx.actions.placeOrder();
  return { placed: true };
});
`;
      const automation: ComposedAutomation = {
        id: "place",
        siteId,
        version: 1,
        source,
        dependencies: automationDependencies([place]),
      };
      const agent = countingAgent(() => ({
        success: true,
        validated: true,
        candidate: {
          id: "place-1",
          baseVersion: 1,
          changes: [
            {
              type: "replace-locator",
              stepId: "place-order",
              locator: { strategy: "role", role: "button", name: "Submit order" },
            },
          ],
        },
      }));
      const wave = createBarrier(CALLERS);
      const flights = new RepairFlightCoordinator();
      const results = await Promise.all(
        Array.from({ length: CALLERS }, (_, index) =>
          runAutomation(
            browser,
            { ...automation, id: `place-${index}` },
            {
              registry,
              startUrl: fixture.url,
              stepTimeoutMs: 300,
              agent: agent.agent,
              repairFlights: flights,
              beforeSharedRepair: () => wave.enter(),
            },
          ),
        ),
      );
      assert.equal(agent.calls, 0);
      assert.equal(
        results.every((result) => result.requiresApproval === true),
        true,
      );
      assert.equal(
        results.every((result) => result.retried === undefined),
        true,
      );
      assert.equal(
        results.every((result) => result.success === false),
        true,
      );
      assert.equal(
        results.every((result) => result.automation?.source === source),
        true,
      );
      assert.equal((await registry.get(place.id))?.version, 1);
      assert.equal(sumCoordination(results).repairsCommitted, 0);
    });
  } finally {
    await fixture.close();
  }
});

test(
  "repairing an earlier safe action does not live-execute a later side effect",
  { timeout: 90_000 },
  async () => {
    const fixture = await startFixtureServer({
      "/": { html: emailThenOrderHtml("E-mail") },
    });
    try {
      await withBrowser(async (browser) => {
        const siteId = new URL(fixture.url).host;
        const fillEmail = defineAction({
          id: "shop.fill-email",
          siteId,
          name: "fillEmail",
          description: "Fill the checkout email field",
          inputs: { email: string() },
          safety: "browser-local",
          steps: [
            fill({
              id: "email",
              locator: label("Email"),
              value: inputRef("email"),
              safety: "browser-local",
            }),
          ],
        });
        const place = defineAction({
          id: "shop.place-order",
          siteId,
          name: "placeOrder",
          description: "Place the current order",
          safety: "external-side-effect",
          steps: [
            click({
              id: "place",
              locator: role("button", { name: "Place order" }),
              safety: "external-side-effect",
            }),
          ],
        });
        const registry = createMemoryRegistry([fillEmail, place]);
        const source = `
export default defineAutomation(async (ctx, input) => {
  await ctx.actions.fillEmail({ email: input.email });
  await ctx.actions.placeOrder();
  return { placed: true };
});
`;
        const automation: ComposedAutomation = {
          id: "email-then-order",
          siteId,
          version: 1,
          source,
          dependencies: automationDependencies([fillEmail, place]),
        };
        const agent = countingAgent(() => ({
          success: true,
          validated: true,
          candidate: {
            id: "email-1",
            baseVersion: 1,
            changes: [
              {
                type: "replace-locator",
                stepId: "email",
                locator: { strategy: "label", label: "E-mail" },
              },
            ],
          },
        }));
        const wave = createBarrier(6);
        const flights = new RepairFlightCoordinator();
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            runAutomation(
              browser,
              { ...automation, id: `email-${index}` },
              {
                registry,
                startUrl: fixture.url,
                input: { email: "user@example.com" },
                stepTimeoutMs: 300,
                agent: agent.agent,
                repairFlights: flights,
                beforeSharedRepair: () => wave.enter(),
                haltBefore: (step) => !mayValidateStepLive(step),
              },
            ),
          ),
        );
        assert.equal(agent.calls, 1);
        assert.equal((await registry.get(fillEmail.id))?.version, 2);
        assert.equal((await registry.get(place.id))?.version, 1);
        assert.equal(
          results.every((result) => result.halted === true && result.retried === true),
          true,
          firstError(results),
        );
        assert.equal(
          results.every((result) => result.automation?.source === source),
          true,
        );
      });
    } finally {
      await fixture.close();
    }
  },
);

test("distinct broken actions repair on independent flights", { timeout: 90_000 }, async () => {
  const fixture = await startFixtureServer({
    "/": { html: catalogWithOpenHtml("Find", "View") },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const search = catalogSearch(siteId);
      const open = catalogOpenButton(siteId);
      const registry = createMemoryRegistry([search, open]);
      const wave = createBarrier(8);
      let searchStarted!: () => void;
      let openStarted!: () => void;
      const searchReady = new Promise<void>((resolve) => {
        searchStarted = resolve;
      });
      const openReady = new Promise<void>((resolve) => {
        openStarted = resolve;
      });
      const searchAgent = countingAgent(() => findPatch(1), {
        ready: searchStarted,
        waitFor: openReady,
      });
      const openAgent = countingAgent(
        () => ({
          success: true,
          validated: true,
          candidate: {
            id: "open-view",
            baseVersion: 1,
            changes: [
              {
                type: "replace-locator",
                stepId: "open",
                locator: { strategy: "role", role: "button", name: "View" },
              },
            ],
          },
        }),
        { ready: openStarted, waitFor: searchReady },
      );

      const searchAutomationSource = searchAutomation();
      const openAutomationSource = `
export default defineAutomation(async (ctx) => {
  await ctx.actions.openProduct();
  return { opened: true };
});
`;
      const searchAutomationA = searchCaller(siteId, searchAutomationSource, search);
      const openAutomationA: ComposedAutomation = {
        id: "open",
        siteId,
        version: 1,
        source: openAutomationSource,
        dependencies: automationDependencies([open]),
      };
      const flights = new RepairFlightCoordinator();
      const [searchResults, openResults] = await Promise.all([
        Promise.all(
          Array.from({ length: 4 }, (_, index) =>
            runAutomation(
              browser,
              { ...searchAutomationA, id: `s-${index}` },
              {
                registry,
                startUrl: fixture.url,
                input: { query: "mug" },
                stepTimeoutMs: 300,
                agent: searchAgent.agent,
                repairFlights: flights,
                beforeSharedRepair: () => wave.enter(),
              },
            ),
          ),
        ),
        Promise.all(
          Array.from({ length: 4 }, (_, index) =>
            runAutomation(
              browser,
              { ...openAutomationA, id: `o-${index}` },
              {
                registry,
                startUrl: fixture.url,
                stepTimeoutMs: 300,
                agent: openAgent.agent,
                repairFlights: flights,
                beforeSharedRepair: () => wave.enter(),
              },
            ),
          ),
        ),
      ]);
      assert.equal(
        searchResults.every((result) => result.success),
        true,
        firstError(searchResults),
      );
      assert.equal(
        openResults.every((result) => result.success),
        true,
        firstError(openResults),
      );
      assert.equal(searchAgent.calls, 1);
      assert.equal(openAgent.calls, 1);
      assert.equal((await registry.get(search.id))?.version, 2);
      assert.equal((await registry.get(open.id))?.version, 2);
      assert.equal(
        searchResults.every((result) => result.automation?.source === searchAutomationSource),
        true,
      );
      assert.equal(
        openResults.every((result) => result.automation?.source === openAutomationSource),
        true,
      );
    });
  } finally {
    await fixture.close();
  }
});

test("an incompatible shared advance is rejected before retry", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer({ "/": { html: catalogHtml("Find") } });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const search = catalogSearch(siteId);
      const registry = createMemoryRegistry([search]);
      const breaking = defineAction({
        id: search.id,
        siteId,
        name: search.name,
        description: search.description,
        inputs: { term: string() },
        outputs: { results: array(productRef()) },
        safety: "browser-local",
        version: 2,
        steps: search.implementation.steps.map((step) =>
          step.type === "extract-list"
            ? { ...step, output: "results" }
            : step.type === "fill"
              ? { ...step, value: inputRef("term") }
              : step,
        ),
      });
      const automation = searchCaller(siteId, searchAutomation(), search);
      const agent = countingAgent(async () => {
        await registry.save(breaking);
        return findPatch(1);
      });
      const wave = createBarrier(3);
      const flights = new RepairFlightCoordinator();
      const results = await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          runAutomation(
            browser,
            { ...automation, id: `break-${index}` },
            {
              registry,
              startUrl: fixture.url,
              input: { query: "mug" },
              stepTimeoutMs: 300,
              agent: agent.agent,
              repairFlights: flights,
              beforeSharedRepair: () => wave.enter(),
            },
          ),
        ),
      );
      assert.equal(agent.calls, 1);
      assert.equal(
        results.every((result) => result.success === false),
        true,
      );
      assert.equal(
        results.every((result) =>
          /incompatible with the current implementation/.test(result.error ?? ""),
        ),
        true,
        firstError(results),
      );
      assert.equal((await registry.get(search.id))?.version, 2);
      assert.equal(
        results.every((result) => result.automation?.source === automation.source),
        true,
      );
    });
  } finally {
    await fixture.close();
  }
});

test(
  "runAutomation without an agent does not repair a drifted action",
  { timeout: 30_000 },
  async () => {
    const fixture = await startFixtureServer({ "/": { html: catalogHtml("Find") } });
    try {
      await withBrowser(async (browser) => {
        const siteId = new URL(fixture.url).host;
        const search = catalogSearch(siteId);
        const registry = createMemoryRegistry([search]);
        const result = await runAutomation(
          browser,
          searchCaller(siteId, searchAutomation(), search),
          {
            registry,
            startUrl: fixture.url,
            input: { query: "mug" },
            stepTimeoutMs: 300,
          },
        );
        assert.equal(result.success, false);
        assert.equal(result.retried, undefined);
        assert.equal(result.repairCoordination, undefined);
        assert.equal((await registry.get(search.id))?.version, 1);
      });
    } finally {
      await fixture.close();
    }
  },
);

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mosaik-c25-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function searchCaller(
  siteId: string,
  source: string,
  search: SiteActionDefinition,
): ComposedAutomation {
  return {
    id: "search",
    siteId,
    version: 1,
    source,
    actionIds: [search.id],
    dependencies: automationDependencies([search]),
  };
}

function searchAutomation(): string {
  return `
export default defineAutomation(async (ctx, input) => {
  return await ctx.actions.searchProducts({ query: input.query });
});
`;
}

function catalogSearch(siteId: string) {
  return defineAction({
    id: "shop.search-products",
    siteId,
    name: "searchProducts",
    description: "Search the site's product catalog using a text query",
    inputs: { query: string() },
    outputs: { products: array(productRef()) },
    safety: "browser-local",
    steps: [
      fill({
        id: "query",
        locator: label("Search"),
        value: inputRef("query"),
        safety: "browser-local",
      }),
      click({
        id: "submit",
        locator: role("button", { name: "Search" }),
        safety: "browser-local",
      }),
      extractList({
        id: "products",
        locator: testId("product"),
        output: "products",
        fields: {
          href: hrefField(),
          title: textField(testId("title")),
          price: textField(testId("price")),
        },
        safety: "read-only",
      }),
    ],
  });
}

function catalogOpenButton(siteId: string) {
  return defineAction({
    id: "shop.open-product",
    siteId,
    name: "openProduct",
    description: "Open the featured product on the current page",
    safety: "browser-local",
    steps: [
      click({
        id: "open",
        locator: role("button", { name: "Open" }),
        safety: "browser-local",
      }),
    ],
  });
}

function findPatch(baseVersion: number): Partial<RepairProposal> {
  return {
    success: true,
    validated: true,
    candidate: {
      id: "search-find",
      baseVersion,
      changes: [
        {
          type: "replace-locator",
          stepId: "submit",
          locator: { strategy: "role", role: "button", name: "Find" },
        },
      ],
    },
  };
}

function lookPatch(baseVersion: number): Partial<RepairProposal> {
  return {
    success: true,
    validated: true,
    candidate: {
      id: "search-look",
      baseVersion,
      changes: [
        {
          type: "replace-locator",
          stepId: "submit",
          locator: { strategy: "role", role: "button", name: "Look" },
        },
      ],
    },
  };
}

function countingAgent(
  handler: (request: RepairRequest) => Partial<RepairProposal> | Promise<Partial<RepairProposal>>,
  options: { ready?: () => void; waitFor?: Promise<void> } = {},
): { calls: number; agent: RepairAgent } {
  const state = { calls: 0, agent: undefined as unknown as RepairAgent };
  state.agent = {
    async generateRepair(request) {
      state.calls += 1;
      options.ready?.();
      if (options.waitFor !== undefined) await options.waitFor;
      const next = await handler(request);
      return {
        success: false,
        validated: false,
        modelResponse: "",
        trajectory: [],
        metrics: {
          modelRequests: 1,
          nestedToolCalls: 1,
          codeExecutions: 1,
          durationMs: 1,
          repairSucceeded: next.success === true,
        },
        ...next,
      };
    },
  };
  return state;
}

function createBarrier(count: number): { enter(): Promise<void> } {
  let arrived = 0;
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async enter() {
      arrived += 1;
      if (arrived >= count) release();
      await opened;
    },
  };
}

function sumCoordination(results: AutomationExecutionResult[]) {
  return results.reduce(
    (sum, result) => {
      const metrics = result.repairCoordination;
      if (metrics === undefined) return sum;
      sum.repairAttempts += metrics.repairAttempts;
      sum.repairOwners += metrics.repairOwners;
      sum.repairWaiters += metrics.repairWaiters;
      sum.repairsCommitted += metrics.repairsCommitted;
      sum.repairsDeduplicated += metrics.repairsDeduplicated;
      sum.staleRepairConflicts += metrics.staleRepairConflicts;
      sum.callersRecoveredFromSharedRepair += metrics.callersRecoveredFromSharedRepair;
      return sum;
    },
    {
      repairAttempts: 0,
      repairOwners: 0,
      repairWaiters: 0,
      repairsCommitted: 0,
      repairsDeduplicated: 0,
      staleRepairConflicts: 0,
      callersRecoveredFromSharedRepair: 0,
    },
  );
}

function firstError(results: AutomationExecutionResult[]): string {
  return results.find((result) => !result.success)?.error ?? "all succeeded";
}

function assertInterfaceUnchanged(before: SiteActionDefinition, after: SiteActionDefinition): void {
  assert.equal(after.id, before.id);
  assert.equal(after.siteId, before.siteId);
  assert.equal(after.name, before.name);
  assert.deepEqual(after.inputs, before.inputs);
  assert.deepEqual(after.outputs, before.outputs);
  assert.equal(after.safety, before.safety);
}

function assertLocatorName(action: SiteActionDefinition, stepId: string, name: string): void {
  const step = action.implementation.steps.find((entry) => entry.id === stepId);
  assert.ok(step && "locator" in step);
  const locator = step.locator;
  assert.equal(locator.strategy === "role" ? locator.name : undefined, name);
}

function catalogHtml(button: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Catalog</title></head>
  <body>
    <main>
      <form aria-label="Catalog search">
        <label>Search <input name="q" /></label>
        <button type="submit">${button}</button>
      </form>
      <ul>
        <li data-product-row>
          <a href="/mug" data-testid="product">
            <span data-testid="title">Ceramic mug</span>
            <span data-testid="price">€18.00</span>
          </a>
        </li>
      </ul>
    </main>
    <script>
      document.querySelector("form").addEventListener("submit", (event) => {
        event.preventDefault();
      });
    </script>
  </body>
</html>
`;
}

function catalogWithOpenHtml(searchButton: string, openButton: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Catalog</title></head>
  <body>
    <main>
      <form aria-label="Catalog search">
        <label>Search <input name="q" /></label>
        <button type="submit">${searchButton}</button>
      </form>
      <button type="button">${openButton}</button>
      <ul>
        <li data-product-row>
          <a href="/mug" data-testid="product">
            <span data-testid="title">Ceramic mug</span>
            <span data-testid="price">€18.00</span>
          </a>
        </li>
      </ul>
    </main>
    <script>
      document.querySelector("form").addEventListener("submit", (event) => {
        event.preventDefault();
      });
    </script>
  </body>
</html>
`;
}

function placeOrderHtml(labelText: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Shop checkout</title></head>
  <body>
    <main>
      <button type="button" id="place">${labelText}</button>
    </main>
    <script>
      window.__placed = false;
      document.getElementById("place").addEventListener("click", () => {
        window.__placed = true;
      });
    </script>
  </body>
</html>
`;
}

function emailThenOrderHtml(emailLabel: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Shop checkout</title></head>
  <body>
    <main>
      <form aria-label="Checkout">
        <label>${emailLabel} <input name="email" /></label>
        <button type="button" id="place">Place order</button>
      </form>
    </main>
    <script>
      window.__placed = false;
      document.getElementById("place").addEventListener("click", () => {
        window.__placed = true;
      });
    </script>
  </body>
</html>
`;
}

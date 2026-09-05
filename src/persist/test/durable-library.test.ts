import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { defineAction, string, type SiteActionDefinition } from "../../capabilities/index.js";
import { extractText, role } from "../../core/index.js";
import type { ComposedAutomation } from "../../automations/types.js";
import {
  openDurableMosaikStore,
  type RemoteLibraryBackend,
  type RemoteLibraryWriteResult,
} from "../durable-library.js";
import { openFileRepository } from "../repository.js";

test("durable library publishes seeds and hydrates learned actions and automations", async () => {
  const remote = new MemoryRemoteLibraryBackend();
  await withStore(async (first) => {
    await first.siteActions.save(headingAction("example.extract-heading", "extractHeading"));
    const durable = await openDurableMosaikStore({
      local: first,
      remote,
      siteId: "example.com",
    });
    assert.equal(durable.metrics.actionsWritten, 1);
    await durable.store.siteActions.save(
      headingAction("example.extract-subheading", "extractSubheading", "heading", 2),
    );
    await durable.store.saveAutomation({
      id: "read-headings",
      siteId: "example.com",
      source: `
        import { defineAutomation } from "mosaik/automations";
        import { extractHeading, extractSubheading } from "../actions/index.js";
        export default defineAutomation(async () => ({
          heading: await extractHeading(),
          subheading: await extractSubheading(),
        }));
      `,
      version: 1,
    });
    assert.equal(durable.metrics.actionsWritten, 2);
    assert.equal(durable.metrics.automationsWritten, 1);
  });

  await withStore(async (second) => {
    const durable = await openDurableMosaikStore({
      local: second,
      remote,
      siteId: "example.com",
    });
    assert.deepEqual(
      (await durable.store.siteActions.list("example.com")).map((action) => action.name),
      ["extractHeading", "extractSubheading"],
    );
    assert.equal((await durable.store.getAutomation("example.com", "read-headings"))?.version, 1);
    assert.deepEqual(durable.metrics, {
      mode: "redis",
      actionsLoaded: 2,
      automationsLoaded: 1,
      actionsWritten: 0,
      automationsWritten: 0,
      conflicts: 0,
    });
  });
});

test("durable library rejects a concurrent action-name conflict", async () => {
  const remote = new MemoryRemoteLibraryBackend();
  await withStore(async (first) => {
    await withStore(async (second) => {
      const left = await openDurableMosaikStore({
        local: first,
        remote,
        siteId: "example.com",
      });
      const right = await openDurableMosaikStore({
        local: second,
        remote,
        siteId: "example.com",
      });
      await left.store.siteActions.save(headingAction("example.left-heading", "extractHeading"));
      await assert.rejects(
        () =>
          right.store.siteActions.save(
            headingAction("example.right-heading", "extractHeading", "heading", 2),
          ),
        /Remote library name conflict/,
      );
      assert.equal(right.metrics.conflicts, 1);
    });
  });
});

test("durable library syncs writes made directly by child processes", async () => {
  const remote = new MemoryRemoteLibraryBackend();
  await withStore(async (local) => {
    const durable = await openDurableMosaikStore({
      local,
      remote,
      siteId: "example.com",
    });
    await local.siteActions.save(headingAction("example.child-heading", "extractHeading"));
    await local.saveAutomation({
      id: "child-automation",
      siteId: "example.com",
      source: `
        import { defineAutomation } from "mosaik/automations";
        import { extractHeading } from "../actions/extractHeading.js";
        export default defineAutomation(async () => extractHeading());
      `,
      version: 1,
    });

    await durable.sync();

    assert.equal((await remote.findAction("example.child-heading"))?.name, "extractHeading");
    assert.equal((await remote.getAutomation("example.com", "child-automation"))?.version, 1);
    assert.equal(durable.metrics.actionsWritten, 1);
    assert.equal(durable.metrics.automationsWritten, 1);
    await durable.sync();
    assert.equal(durable.metrics.actionsWritten, 1);
    assert.equal(durable.metrics.automationsWritten, 1);
  });
});

test("durable library publishes bundled seed automations", async () => {
  const remote = new MemoryRemoteLibraryBackend();
  await withStore(async (local) => {
    await local.saveAutomation({
      id: "seed-automation",
      siteId: "example.com",
      source: `
        import { defineAutomation } from "mosaik/automations";
        export default defineAutomation(async () => ({ seeded: true }));
      `,
      version: 1,
    });
    const durable = await openDurableMosaikStore({
      local,
      remote,
      siteId: "example.com",
    });
    assert.equal((await remote.getAutomation("example.com", "seed-automation"))?.version, 1);
    assert.equal(durable.metrics.automationsWritten, 1);
  });
});

function headingAction(
  id: string,
  name: string,
  roleName = "heading",
  level?: number,
): SiteActionDefinition {
  return defineAction({
    id,
    siteId: "example.com",
    name,
    description: "Read a page heading",
    safety: "read-only",
    outputs: { heading: string() },
    steps: [
      extractText({
        id: "heading",
        locator: role(roleName, level === undefined ? undefined : { name: `Level ${level}` }),
        output: "heading",
        safety: "read-only",
      }),
    ],
  });
}

async function withStore(
  run: (store: ReturnType<typeof openFileRepository>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mosaik-durable-library-"));
  try {
    await run(openFileRepository({ dataRoot: join(root, ".mosaik"), libraryRoot: root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

class MemoryRemoteLibraryBackend implements RemoteLibraryBackend {
  private readonly actions = new Map<string, SiteActionDefinition>();
  private readonly automations = new Map<string, ComposedAutomation>();

  async listSites(): Promise<string[]> {
    return [
      ...new Set([
        ...[...this.actions.values()].map((action) => action.siteId),
        ...[...this.automations.values()].map((automation) => automation.siteId),
      ]),
    ].sort();
  }

  async listActions(siteId: string): Promise<SiteActionDefinition[]> {
    return [...this.actions.values()].filter((action) => action.siteId === siteId);
  }

  async findAction(actionId: string): Promise<SiteActionDefinition | undefined> {
    return this.actions.get(actionId);
  }

  async writeAction(
    action: SiteActionDefinition,
    expectedVersion: number | undefined,
  ): Promise<RemoteLibraryWriteResult> {
    const current = this.actions.get(action.id);
    if (current !== undefined && JSON.stringify(current) === JSON.stringify(action)) {
      return "unchanged";
    }
    const claim = [...this.actions.values()].find(
      (entry) => entry.siteId === action.siteId && entry.name === action.name,
    );
    if (claim !== undefined && claim.id !== action.id) return "name-conflict";
    if (
      current === undefined ? expectedVersion !== undefined : current.version !== expectedVersion
    ) {
      return "conflict";
    }
    this.actions.set(action.id, structuredClone(action));
    return "stored";
  }

  async listAutomations(siteId: string): Promise<ComposedAutomation[]> {
    return [...this.automations.values()].filter((automation) => automation.siteId === siteId);
  }

  async getAutomation(
    siteId: string,
    automationId: string,
  ): Promise<ComposedAutomation | undefined> {
    return this.automations.get(`${siteId}:${automationId}`);
  }

  async writeAutomation(
    automation: ComposedAutomation,
    expectedVersion: number | undefined,
  ): Promise<RemoteLibraryWriteResult> {
    const key = `${automation.siteId}:${automation.id}`;
    const current = this.automations.get(key);
    if (current !== undefined && JSON.stringify(current) === JSON.stringify(automation)) {
      return "unchanged";
    }
    if (
      current === undefined ? expectedVersion !== undefined : current.version !== expectedVersion
    ) {
      return "conflict";
    }
    if (current !== undefined && automation.version <= current.version) return "conflict";
    this.automations.set(key, structuredClone(automation));
    return "stored";
  }

  async clear(): Promise<void> {
    this.actions.clear();
    this.automations.clear();
  }

  async close(): Promise<void> {}
}

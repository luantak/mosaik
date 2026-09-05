import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineAction, string, type SiteActionDefinition } from "../../capabilities/index.js";
import { extractText, role } from "../../core/index.js";
import type { ComposedAutomation } from "../../automations/types.js";
import type { RemoteLibraryBackend, RemoteLibraryWriteResult } from "../durable-library.js";
import { pullRemoteLibrary } from "../pull.js";
import { openFileRepository } from "../repository.js";

test("pull creates canonical local actions and automations from the remote library", async () => {
  await withRepository(async (root, local) => {
    const remote = new MemoryRemoteLibrary([headingAction()], [headingAutomation()]);
    const result = await pullRemoteLibrary({ remote, local });
    assert.deepEqual(
      {
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        conflicts: result.conflicts,
      },
      { created: 2, updated: 0, unchanged: 0, conflicts: 0 },
    );
    assert.match(
      await readFile(join(root, "sites", "example.com", "actions", "readHeading.ts"), "utf8"),
      /role\("heading"/,
    );
    assert.match(
      await readFile(join(root, "sites", "example.com", "automations", "read-heading.ts"), "utf8"),
      /readHeading/,
    );

    const unchanged = await pullRemoteLibrary({ remote, local });
    assert.equal(unchanged.unchanged, 2);
    assert.equal(unchanged.created, 0);
  });
});

test("pull protects local edits and force accepts the remote record", async () => {
  await withRepository(async (_root, local) => {
    const remoteAction = headingAction();
    const remote = new MemoryRemoteLibrary([remoteAction], []);
    await pullRemoteLibrary({ remote, local });
    await local.siteActions.save({ ...remoteAction, description: "Locally edited description" });

    const protectedResult = await pullRemoteLibrary({ remote, local });
    assert.equal(protectedResult.conflicts, 1);
    assert.equal(
      (await local.siteActions.get(remoteAction.id))?.description,
      "Locally edited description",
    );

    const forced = await pullRemoteLibrary({ remote, local, force: true });
    assert.equal(forced.updated, 1);
    assert.equal(forced.conflicts, 0);
    assert.equal(
      (await local.siteActions.get(remoteAction.id))?.description,
      remoteAction.description,
    );
  });
});

test("pull dry-run reports changes without creating canonical files", async () => {
  await withRepository(async (root, local) => {
    const result = await pullRemoteLibrary({
      remote: new MemoryRemoteLibrary([headingAction()], [headingAutomation()]),
      local,
      dryRun: true,
    });
    assert.equal(result.created, 2);
    await assert.rejects(() => access(join(root, "sites")), /ENOENT/);
  });
});

function headingAction(): SiteActionDefinition {
  return defineAction({
    id: "example.read-heading",
    siteId: "example.com",
    name: "readHeading",
    description: "Read the page heading",
    safety: "read-only",
    outputs: { heading: string() },
    steps: [
      extractText({
        id: "heading",
        locator: role("heading"),
        output: "heading",
        safety: "read-only",
      }),
    ],
  });
}

function headingAutomation(): ComposedAutomation {
  return {
    id: "read-heading",
    siteId: "example.com",
    source: `
      import { defineAutomation } from "mosaik/automations";
      import { readHeading } from "../actions/readHeading.js";
      export default defineAutomation(async () => readHeading());
    `,
    version: 1,
  };
}

async function withRepository(
  run: (root: string, repository: ReturnType<typeof openFileRepository>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mosaik-pull-test-"));
  try {
    await run(root, openFileRepository({ dataRoot: join(root, ".mosaik"), libraryRoot: root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

class MemoryRemoteLibrary implements RemoteLibraryBackend {
  constructor(
    private readonly actions: SiteActionDefinition[],
    private readonly automations: ComposedAutomation[],
  ) {}

  async listSites(): Promise<string[]> {
    return [
      ...new Set([
        ...this.actions.map((action) => action.siteId),
        ...this.automations.map((automation) => automation.siteId),
      ]),
    ];
  }

  async listActions(siteId: string): Promise<SiteActionDefinition[]> {
    return this.actions
      .filter((action) => action.siteId === siteId)
      .map((action) => structuredClone(action));
  }

  async findAction(actionId: string): Promise<SiteActionDefinition | undefined> {
    return this.actions.find((action) => action.id === actionId);
  }

  async writeAction(
    _action: SiteActionDefinition,
    _expectedVersion: number | undefined,
  ): Promise<RemoteLibraryWriteResult> {
    throw new Error("not implemented");
  }

  async listAutomations(siteId: string): Promise<ComposedAutomation[]> {
    return this.automations
      .filter((automation) => automation.siteId === siteId)
      .map((automation) => structuredClone(automation));
  }

  async getAutomation(
    siteId: string,
    automationId: string,
  ): Promise<ComposedAutomation | undefined> {
    return this.automations.find(
      (automation) => automation.siteId === siteId && automation.id === automationId,
    );
  }

  async writeAutomation(
    _automation: ComposedAutomation,
    _expectedVersion: number | undefined,
  ): Promise<RemoteLibraryWriteResult> {
    throw new Error("not implemented");
  }

  async clear(): Promise<void> {}

  async close(): Promise<void> {}
}

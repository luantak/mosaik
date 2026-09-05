import {
  assertSiteCapability,
  compileSiteAction,
  normalizeSiteId,
  type ActionVersionUpdate,
  type SiteActionDefinition,
  type SiteActionRegistry,
} from "../capabilities/index.js";
import { assertMosaikAutomation } from "../capabilities/code-mode.js";
import type { ComposedAutomation } from "../automations/types.js";
import type { MosaikStore } from "./repository.js";

export type RemoteLibraryWriteResult = "stored" | "unchanged" | "conflict" | "name-conflict";

export interface RemoteLibraryBackend {
  listSites(): Promise<string[]>;
  listActions(siteId: string): Promise<SiteActionDefinition[]>;
  findAction(actionId: string): Promise<SiteActionDefinition | undefined>;
  writeAction(
    action: SiteActionDefinition,
    expectedVersion: number | undefined,
  ): Promise<RemoteLibraryWriteResult>;
  listAutomations(siteId: string): Promise<ComposedAutomation[]>;
  getAutomation(siteId: string, automationId: string): Promise<ComposedAutomation | undefined>;
  writeAutomation(
    automation: ComposedAutomation,
    expectedVersion: number | undefined,
  ): Promise<RemoteLibraryWriteResult>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

export interface LibraryPersistenceMetrics {
  mode: "redis";
  actionsLoaded: number;
  automationsLoaded: number;
  actionsWritten: number;
  automationsWritten: number;
  conflicts: number;
}

export interface DurableMosaikStore {
  store: MosaikStore;
  metrics: LibraryPersistenceMetrics;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export async function openDurableMosaikStore(input: {
  local: MosaikStore;
  remote: RemoteLibraryBackend;
  siteId: string;
}): Promise<DurableMosaikStore> {
  const metrics: LibraryPersistenceMetrics = {
    mode: "redis",
    actionsLoaded: 0,
    automationsLoaded: 0,
    actionsWritten: 0,
    automationsWritten: 0,
    conflicts: 0,
  };
  const hydration = new Map<string, Promise<void>>();
  const actionBaselines = new Map<string, string>();
  const automationBaselines = new Map<string, string>();

  const actionKey = (siteId: string, actionId: string): string => `${siteId}:${actionId}`;
  const automationKey = (siteId: string, automationId: string): string =>
    `${siteId}:${automationId}`;

  const recordWrite = (
    kind: "action" | "automation",
    id: string,
    result: RemoteLibraryWriteResult,
  ): void => {
    if (result === "stored") {
      if (kind === "action") metrics.actionsWritten += 1;
      else metrics.automationsWritten += 1;
      return;
    }
    if (result === "unchanged") return;
    metrics.conflicts += 1;
    const detail = result === "name-conflict" ? "name conflict" : "version conflict";
    throw new Error(`Remote library ${detail} for ${kind} ${id}; retry the invocation`);
  };

  const hydrateSite = async (rawSiteId: string): Promise<void> => {
    const siteId = normalizeSiteId(rawSiteId);
    const existing = hydration.get(siteId);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      const [seedActions, remoteActions, remoteAutomations] = await Promise.all([
        input.local.siteActions.list(siteId),
        input.remote.listActions(siteId),
        input.remote.listAutomations(siteId),
      ]);
      const seedsById = new Map(seedActions.map((action) => [action.id, action]));
      for (const action of remoteActions) {
        const compiled = compileSiteAction(action);
        assertSiteCapability(compiled);
        const seed = seedsById.get(compiled.id);
        if (seed === undefined || compiled.version >= seed.version) {
          await input.local.siteActions.save(compiled);
        }
      }
      for (const automation of remoteAutomations) {
        assertRemoteAutomation(automation, siteId);
        await input.local.saveAutomation(automation);
      }
      metrics.actionsLoaded += remoteActions.length;
      metrics.automationsLoaded += remoteAutomations.length;

      const remoteById = new Map(remoteActions.map((action) => [action.id, action]));
      for (const action of await input.local.siteActions.list(siteId)) {
        const remote = remoteById.get(action.id);
        const result = await input.remote.writeAction(action, remote?.version);
        recordWrite("action", action.id, result);
        actionBaselines.set(actionKey(siteId, action.id), JSON.stringify(action));
      }
      const remoteAutomationsById = new Map(
        remoteAutomations.map((automation) => [automation.id, automation]),
      );
      for (const id of await input.local.listAutomationIds(siteId)) {
        const automation = await input.local.getAutomation(siteId, id);
        if (automation === undefined) continue;
        const remote = remoteAutomationsById.get(automation.id);
        const result = await input.remote.writeAutomation(automation, remote?.version);
        recordWrite("automation", automation.id, result);
        automationBaselines.set(automationKey(siteId, automation.id), JSON.stringify(automation));
      }
    })();
    hydration.set(siteId, pending);
    try {
      await pending;
    } catch (error) {
      hydration.delete(siteId);
      throw error;
    }
  };

  const siteActions: SiteActionRegistry = {
    ...(input.local.siteActions.cases ? { cases: input.local.siteActions.cases } : {}),
    async save(action) {
      const siteId = normalizeSiteId(action.siteId);
      await hydrateSite(siteId);
      const previous = await input.remote.findAction(action.id);
      await input.local.siteActions.save(action);
      let canonical = await input.local.siteActions.get(action.id);
      if (canonical === undefined) throw new Error(`Saved action ${action.id} could not be loaded`);
      if (
        previous !== undefined &&
        canonical.version <= previous.version &&
        JSON.stringify(canonical) !== JSON.stringify(previous)
      ) {
        await input.local.siteActions.save({ ...canonical, version: previous.version + 1 });
        canonical = (await input.local.siteActions.get(action.id))!;
      }
      const result = await input.remote.writeAction(canonical, previous?.version);
      recordWrite("action", canonical.id, result);
      actionBaselines.set(actionKey(siteId, canonical.id), JSON.stringify(canonical));
    },

    async get(actionId) {
      const local = await input.local.siteActions.get(actionId);
      if (local !== undefined) return local;
      const remote = await input.remote.findAction(actionId);
      if (remote === undefined) return undefined;
      await hydrateSite(remote.siteId);
      return input.local.siteActions.get(actionId);
    },

    async list(siteId) {
      await hydrateSite(siteId);
      return input.local.siteActions.list(siteId);
    },

    async listSites() {
      const [local, remote] = await Promise.all([
        input.local.siteActions.listSites(),
        input.remote.listSites(),
      ]);
      return [...new Set([...local, ...remote])].sort();
    },

    async updateActionIfVersion(update): Promise<ActionVersionUpdate> {
      await hydrateSite(update.siteId);
      const result = await input.local.siteActions.updateActionIfVersion(update);
      if (!result.updated) return result;
      const remoteResult = await input.remote.writeAction(result.action, update.expectedVersion);
      if (remoteResult === "stored" || remoteResult === "unchanged") {
        if (remoteResult === "stored") metrics.actionsWritten += 1;
        return result;
      }
      metrics.conflicts += 1;
      const current = await input.remote.findAction(update.actionId);
      if (current !== undefined) await input.local.siteActions.save(current);
      return {
        updated: false,
        reason: "version-conflict",
        ...(current === undefined ? {} : { current }),
      };
    },
  };

  const store: MosaikStore = {
    dataRoot: input.local.dataRoot,
    libraryRoot: input.local.libraryRoot,
    siteActions,
    saveAuthAutomation: (automation) => input.local.saveAuthAutomation(automation),
    getAuthAutomation: (id) => input.local.getAuthAutomation(id),
    listAuthAutomationIds: () => input.local.listAuthAutomationIds(),

    async saveAutomation(automation) {
      const siteId = normalizeSiteId(automation.siteId);
      await hydrateSite(siteId);
      const previous = await input.remote.getAutomation(siteId, automation.id);
      let next = { ...automation, siteId };
      if (
        previous !== undefined &&
        next.version <= previous.version &&
        JSON.stringify(next) !== JSON.stringify(previous)
      ) {
        next = { ...next, version: previous.version + 1 };
      }
      assertRemoteAutomation(next, siteId);
      await input.local.saveAutomation(next);
      const canonical = await input.local.getAutomation(siteId, next.id);
      if (canonical === undefined)
        throw new Error(`Saved automation ${next.id} could not be loaded`);
      const result = await input.remote.writeAutomation(canonical, previous?.version);
      recordWrite("automation", canonical.id, result);
      automationBaselines.set(automationKey(siteId, canonical.id), JSON.stringify(canonical));
    },

    async getAutomation(siteId, id) {
      await hydrateSite(siteId);
      return input.local.getAutomation(siteId, id);
    },

    async listAutomationIds(siteId) {
      if (siteId === undefined) {
        for (const knownSite of await siteActions.listSites()) await hydrateSite(knownSite);
      } else {
        await hydrateSite(siteId);
      }
      return input.local.listAutomationIds(siteId);
    },

    async inspectLearnedLibrary() {
      for (const siteId of await siteActions.listSites()) await hydrateSite(siteId);
      return input.local.inspectLearnedLibrary();
    },

    async clearLearnedLibrary() {
      const inventory = await this.inspectLearnedLibrary();
      await Promise.all([input.local.clearLearnedLibrary(), input.remote.clear()]);
      hydration.clear();
      return inventory;
    },
  };

  const sync = async (): Promise<void> => {
    const siteId = normalizeSiteId(input.siteId);
    await hydrateSite(siteId);
    for (const action of await input.local.siteActions.list(siteId)) {
      const key = actionKey(siteId, action.id);
      if (actionBaselines.get(key) === JSON.stringify(action)) continue;
      const previous = await input.remote.findAction(action.id);
      let canonical = action;
      if (
        previous !== undefined &&
        canonical.version <= previous.version &&
        JSON.stringify(canonical) !== JSON.stringify(previous)
      ) {
        await input.local.siteActions.save({ ...canonical, version: previous.version + 1 });
        canonical = (await input.local.siteActions.get(action.id))!;
      }
      const result = await input.remote.writeAction(canonical, previous?.version);
      recordWrite("action", canonical.id, result);
      actionBaselines.set(key, JSON.stringify(canonical));
    }
    for (const id of await input.local.listAutomationIds(siteId)) {
      const key = automationKey(siteId, id);
      const automation = await input.local.getAutomation(siteId, id);
      if (automation === undefined || automationBaselines.get(key) === JSON.stringify(automation))
        continue;
      const previous = await input.remote.getAutomation(siteId, id);
      let canonical = automation;
      if (
        previous !== undefined &&
        canonical.version <= previous.version &&
        JSON.stringify(canonical) !== JSON.stringify(previous)
      ) {
        canonical = { ...canonical, version: previous.version + 1 };
        await input.local.saveAutomation(canonical);
      }
      const result = await input.remote.writeAutomation(canonical, previous?.version);
      recordWrite("automation", canonical.id, result);
      automationBaselines.set(key, JSON.stringify(canonical));
    }
  };

  try {
    await hydrateSite(input.siteId);
    return { store, metrics, sync, close: () => input.remote.close() };
  } catch (error) {
    await input.remote.close();
    throw error;
  }
}

function assertRemoteAutomation(automation: ComposedAutomation, expectedSiteId: string): void {
  if (automation.id.trim().length === 0) throw new Error("Remote automation id is required");
  if (normalizeSiteId(automation.siteId) !== expectedSiteId) {
    throw new Error(`Remote automation ${automation.id} belongs to a different site`);
  }
  if (!Number.isSafeInteger(automation.version) || automation.version < 1) {
    throw new Error(`Remote automation ${automation.id} has an invalid version`);
  }
  assertMosaikAutomation(automation.source);
}

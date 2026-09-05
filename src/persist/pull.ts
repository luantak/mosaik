import { constants } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { format } from "oxfmt";
import type { SiteActionDefinition } from "../capabilities/index.js";
import {
  actionMetaPath,
  actionSourcePath,
  automationMetaPath,
  automationSourcePath,
} from "../library/paths.js";
import type { ComposedAutomation } from "../automations/types.js";
import type { RemoteLibraryBackend } from "./durable-library.js";
import type { MosaikStore } from "./repository.js";

export type LibraryPullStatus = "created" | "updated" | "unchanged" | "conflict";

export interface LibraryPullChange {
  kind: "action" | "automation";
  siteId: string;
  id: string;
  status: LibraryPullStatus;
  reason?: string;
}

export interface LibraryPullResult {
  changes: LibraryPullChange[];
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
}

export async function pullRemoteLibrary(input: {
  remote: RemoteLibraryBackend;
  local: MosaikStore;
  siteId?: string;
  dryRun?: boolean;
  force?: boolean;
}): Promise<LibraryPullResult> {
  const sites = input.siteId === undefined ? await input.remote.listSites() : [input.siteId];
  const changes: LibraryPullChange[] = [];
  for (const siteId of sites) {
    const [remoteActions, remoteAutomations, localActions] = await Promise.all([
      input.remote.listActions(siteId),
      input.remote.listAutomations(siteId),
      input.local.siteActions.list(siteId),
    ]);
    const localActionsById = new Map(localActions.map((action) => [action.id, action]));
    const localActionsByName = new Map(localActions.map((action) => [action.name, action]));
    for (const remote of remoteActions) {
      const local = localActionsById.get(remote.id);
      const nameOwner = localActionsByName.get(remote.name);
      if (nameOwner !== undefined && nameOwner.id !== remote.id) {
        changes.push({
          kind: "action",
          siteId,
          id: remote.id,
          status: "conflict",
          reason: `local action ${nameOwner.id} already uses the name ${remote.name}`,
        });
        continue;
      }
      changes.push(await pullAction(input, remote, local));
    }
    for (const remote of remoteAutomations) {
      changes.push(await pullAutomation(input, remote));
    }
  }
  return {
    changes,
    created: changes.filter((change) => change.status === "created").length,
    updated: changes.filter((change) => change.status === "updated").length,
    unchanged: changes.filter((change) => change.status === "unchanged").length,
    conflicts: changes.filter((change) => change.status === "conflict").length,
  };
}

async function pullAction(
  input: Parameters<typeof pullRemoteLibrary>[0],
  remote: SiteActionDefinition,
  local: SiteActionDefinition | undefined,
): Promise<LibraryPullChange> {
  if (local === undefined) {
    if (input.dryRun !== true) await input.local.siteActions.save(remote);
    return change("action", remote, "created");
  }
  if (isDeepStrictEqual(actionContent(local), actionContent(remote))) {
    return change("action", remote, "unchanged");
  }
  const hasMetadata = await readable(actionMetaPath(input.local.dataRoot, local.siteId, local.id));
  if (input.force !== true && (!hasMetadata || remote.version <= local.version)) {
    return change(
      "action",
      remote,
      "conflict",
      hasMetadata
        ? `local version ${local.version} differs from remote version ${remote.version}`
        : "local source has no version metadata",
    );
  }
  if (input.dryRun !== true) {
    if (input.force === true) {
      await Promise.all([
        rm(actionMetaPath(input.local.dataRoot, local.siteId, local.id), { force: true }),
        rm(actionSourcePath(input.local.libraryRoot, local.siteId, local.name), { force: true }),
      ]);
    }
    await input.local.siteActions.save(remote);
    if (local.name !== remote.name) {
      await rm(actionSourcePath(input.local.libraryRoot, local.siteId, local.name), {
        force: true,
      });
    }
  }
  return change("action", remote, "updated");
}

async function pullAutomation(
  input: Parameters<typeof pullRemoteLibrary>[0],
  remote: ComposedAutomation,
): Promise<LibraryPullChange> {
  const local = await input.local.getAutomation(remote.siteId, remote.id);
  const sourcePath = automationSourcePath(input.local.libraryRoot, remote.siteId, remote.id);
  const localSource = local?.source ?? (await readOptionalText(sourcePath));
  if (localSource === undefined) {
    if (input.dryRun !== true) await input.local.saveAutomation(remote);
    return change("automation", remote, "created");
  }
  if ((await normalizeSource(localSource)) === (await normalizeSource(remote.source))) {
    return change("automation", remote, "unchanged");
  }
  if (input.force !== true && (local === undefined || remote.version <= local.version)) {
    return change(
      "automation",
      remote,
      "conflict",
      local === undefined
        ? "local source has no version metadata"
        : `local version ${local.version} differs from remote version ${remote.version}`,
    );
  }
  if (input.dryRun !== true) {
    if (input.force === true) {
      await Promise.all([
        rm(automationMetaPath(input.local.dataRoot, remote.siteId, remote.id), {
          recursive: true,
          force: true,
        }),
        rm(sourcePath, { force: true }),
      ]);
    }
    await input.local.saveAutomation(remote);
  }
  return change("automation", remote, "updated");
}

function actionContent(action: SiteActionDefinition): unknown {
  const {
    version: _version,
    interfaceVersion: _interfaceVersion,
    verification: _verification,
    runStats: _runStats,
    versionHistory: _versionHistory,
    ...content
  } = action;
  return content;
}

function change(
  kind: "action" | "automation",
  record: { siteId: string; id: string },
  status: LibraryPullStatus,
  reason?: string,
): LibraryPullChange {
  return {
    kind,
    siteId: record.siteId,
    id: record.id,
    status,
    ...(reason === undefined ? {} : { reason }),
  };
}

async function normalizeSource(source: string): Promise<string> {
  const formatted = await format("automation.ts", source);
  return formatted.errors.length === 0 ? formatted.code.trim() : source.trim();
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

import { createCaseStore } from "../evidence/store.js";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { format } from "oxfmt";
import {
  assignCompatibilityVersions,
  assertSiteCapability,
  compileSiteAction,
  normalizeSiteId,
  type ActionVersionUpdate,
  type SiteActionDefinition,
  type SiteActionRegistry,
} from "../capabilities/index.js";
import { parseAuthAutomation, type AuthAutomation } from "../auth/index.js";
import { emitActionSource, parseActionSource } from "../library/action-source.js";
import {
  actionMetaPath,
  actionSourceDirectory,
  actionSourcePath,
  decodeLibraryId,
  automationMetaDirectory,
  automationMetaPath,
  automationSourceDirectory,
  automationSourcePath,
} from "../library/paths.js";
import { withKeyedLock } from "./lock.js";
import type { ComposedAutomation, AutomationDependency } from "../automations/types.js";

export interface RepositoryRoots {
  dataRoot: string;
  libraryRoot: string;
}

export interface LearnedLibraryInventory {
  actions: number;
  automations: number;
}

export interface MosaikStore {
  readonly dataRoot: string;
  readonly libraryRoot: string;
  siteActions: SiteActionRegistry;
  saveAuthAutomation(automation: AuthAutomation): Promise<void>;
  getAuthAutomation(id: string): Promise<AuthAutomation | undefined>;
  listAuthAutomationIds(): Promise<string[]>;
  saveAutomation(automation: ComposedAutomation): Promise<void>;
  getAutomation(siteId: string, id: string): Promise<ComposedAutomation | undefined>;
  listAutomationIds(siteId?: string): Promise<string[]>;
  inspectLearnedLibrary(): Promise<LearnedLibraryInventory>;
  clearLearnedLibrary(): Promise<LearnedLibraryInventory>;
}

export function openFileRepository(root: string | RepositoryRoots): MosaikStore {
  const dataRoot = typeof root === "string" ? root : root.dataRoot;
  const libraryRoot = typeof root === "string" ? root : root.libraryRoot;
  const siteActionFile = (siteId: string, actionId: string) =>
    actionMetaPath(dataRoot, siteId, actionId);
  const authAutomationFile = (id: string) => authAutomationFilePath(dataRoot, id);

  const writeActionSource = async (action: SiteActionDefinition): Promise<void> => {
    const path = actionSourcePath(libraryRoot, action.siteId, action.name);
    await writeTypeScript(path, emitActionSource(action));
  };

  const readActionFromSource = async (
    siteId: string,
    actionName: string,
  ): Promise<SiteActionDefinition | undefined> => {
    const path = actionSourcePath(libraryRoot, siteId, actionName);
    const source = await readText(path);
    if (source === undefined) return undefined;
    return parseActionSource(source);
  };

  const siteActions: SiteActionRegistry = {
    cases: createCaseStore(join(dataRoot, "action-cases", "cases.v1.json")),
    async save(action) {
      const incoming = compileSiteAction(action);
      const path = siteActionFile(incoming.siteId, incoming.id);
      await withKeyedLock(path, async () => {
        const raw = await readJson(path);
        const compiled = compileSiteAction(
          assignCompatibilityVersions(raw === undefined ? undefined : asSiteAction(raw), incoming),
        );
        assertSiteCapability(compiled);
        const siblings = await siteActions.list(compiled.siteId);
        const clash = siblings.find(
          (entry) => entry.name === compiled.name && entry.id !== compiled.id,
        );
        if (clash !== undefined) {
          throw new Error(
            `Site ${compiled.siteId} already has an action named ${compiled.name} (${clash.id})`,
          );
        }
        await writeJson(path, compiled);
        await writeActionSource(compiled);
      });
    },

    async get(actionId) {
      for (const siteId of await siteActions.listSites()) {
        const raw = await readJson(siteActionFile(siteId, actionId));
        if (raw === undefined) continue;
        const fromMeta = asSiteAction(raw);
        const fromSource = await readActionFromSource(siteId, fromMeta.name);
        if (fromSource !== undefined) {
          return compileSiteAction({
            ...fromSource,
            version: fromMeta.version,
            interfaceVersion: fromMeta.interfaceVersion,
            verification: fromMeta.verification,
            ...(fromMeta.verificationBasis === undefined
              ? {}
              : { verificationBasis: fromMeta.verificationBasis }),
            ...(fromMeta.runStats === undefined ? {} : { runStats: fromMeta.runStats }),
            ...(fromMeta.versionHistory === undefined
              ? {}
              : { versionHistory: fromMeta.versionHistory }),
            ...(fromMeta.aliases === undefined ? {} : { aliases: fromMeta.aliases }),
          });
        }
        await writeActionSource(fromMeta);
        return fromMeta;
      }
      return undefined;
    },

    async list(siteId) {
      const normalized = normalizeSiteId(siteId);
      const names = await listEncodedNames(
        join(dataRoot, "sites", encodeId(normalized), "actions"),
        false,
      );
      const fromMeta = (
        await Promise.all(names.map((actionId) => siteActions.get(actionId)))
      ).filter((action): action is SiteActionDefinition => action !== undefined);

      const sourceNames = await listTsNames(actionSourceDirectory(libraryRoot, normalized));
      const knownIds = new Set(fromMeta.map((action) => action.id));
      const extras: SiteActionDefinition[] = [];
      for (const actionName of sourceNames) {
        if (fromMeta.some((action) => action.name === actionName)) continue;
        const parsed = await readActionFromSource(normalized, actionName);
        if (parsed === undefined || knownIds.has(parsed.id)) continue;
        await writeJson(siteActionFile(parsed.siteId, parsed.id), parsed);
        extras.push(parsed);
      }

      return [...fromMeta, ...extras].sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
    },

    async listSites() {
      const fromData = await listEncodedNames(join(dataRoot, "sites"), true);
      const fromLibrary = await listEncodedNames(join(libraryRoot, "sites"), true);
      return [...new Set([...fromData, ...fromLibrary])].sort();
    },

    async updateActionIfVersion(input) {
      const compiled = compileSiteAction(input.next);
      const siteId = normalizeSiteId(input.siteId);
      if (compiled.id !== input.actionId) {
        throw new Error("Patched action id must match the update target");
      }
      if (compiled.siteId !== siteId) {
        throw new Error("Patched action site must match the update target");
      }
      const path = siteActionFile(siteId, input.actionId);
      return withKeyedLock(path, async (): Promise<ActionVersionUpdate> => {
        const raw = await readJson(path);
        const current = raw === undefined ? undefined : asSiteAction(raw);
        if (current === undefined || current.version !== input.expectedVersion) {
          return {
            updated: false,
            reason: "version-conflict",
            ...(current === undefined ? {} : { current }),
          };
        }
        const next = compileSiteAction(assignCompatibilityVersions(current, compiled));
        assertSiteCapability(next);
        const siblings = await siteActions.list(siteId);
        const clash = siblings.find((entry) => entry.name === next.name && entry.id !== next.id);
        if (clash !== undefined) {
          throw new Error(
            `Site ${next.siteId} already has an action named ${next.name} (${clash.id})`,
          );
        }
        await writeJson(path, next);
        await writeActionSource(next);
        return { updated: true, action: next };
      });
    },
  };

  return {
    dataRoot,
    libraryRoot,
    siteActions,

    async saveAuthAutomation(automation) {
      const compiled = parseAuthAutomation(automation);
      await writeJson(authAutomationFile(compiled.id), compiled);
    },

    async getAuthAutomation(id) {
      const raw = await readJson(authAutomationFile(id));
      return raw === undefined ? undefined : parseAuthAutomation(raw);
    },

    async listAuthAutomationIds() {
      return listEncodedNames(join(dataRoot, "auth-automations"), true);
    },

    async saveAutomation(automation) {
      const siteId = normalizeSiteId(automation.siteId);
      await writeTypeScript(
        automationSourcePath(libraryRoot, siteId, automation.id),
        automation.source,
      );
      await writeJson(automationMetaPath(dataRoot, siteId, automation.id), {
        id: automation.id,
        siteId,
        version: automation.version,
        ...(automation.actionIds === undefined ? {} : { actionIds: automation.actionIds }),
        ...(automation.dependencies === undefined ? {} : { dependencies: automation.dependencies }),
      });
    },

    async getAutomation(siteId, id) {
      const normalizedSiteId = normalizeSiteId(siteId);
      const raw = await readJson(automationMetaPath(dataRoot, normalizedSiteId, id));
      if (raw === undefined) return undefined;
      const sourceFromFile = await readText(
        automationSourcePath(libraryRoot, normalizedSiteId, id),
      );
      const source =
        sourceFromFile ??
        (typeof raw.source === "string" && raw.source.length > 0 ? raw.source : undefined);
      if (source === undefined) return undefined;
      if (sourceFromFile === undefined) {
        await writeTypeScript(automationSourcePath(libraryRoot, normalizedSiteId, id), source);
      }
      return asAutomation({ ...raw, source });
    },

    async listAutomationIds(siteId) {
      const sites =
        siteId === undefined ? await siteActions.listSites() : [normalizeSiteId(siteId)];
      const fromMeta = await Promise.all(
        sites.map((siteId) => listEncodedNames(automationMetaDirectory(dataRoot, siteId), true)),
      );
      const fromSource = await Promise.all(
        sites.map((siteId) => listTsNames(automationSourceDirectory(libraryRoot, siteId))),
      );
      return [...new Set([...fromMeta.flat(), ...fromSource.flat()])].sort();
    },

    async inspectLearnedLibrary() {
      const sites = await siteActions.listSites();
      const actions = await Promise.all(sites.map((siteId) => siteActions.list(siteId)));
      return {
        actions: actions.reduce((total, entries) => total + entries.length, 0),
        automations: (await this.listAutomationIds()).length,
      };
    },

    async clearLearnedLibrary() {
      const inventory = await this.inspectLearnedLibrary();
      const targets = new Set([join(dataRoot, "sites"), join(libraryRoot, "sites")]);
      await Promise.all([...targets].map((target) => rm(target, { recursive: true, force: true })));
      return inventory;
    },
  };
}

export function authAutomationFilePath(root: string, id: string): string {
  return join(root, "auth-automations", encodeId(id), "current.json");
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

function decodeId(value: string): string {
  return decodeURIComponent(value.replace(/\.json$/, ""));
}

async function listEncodedNames(directory: string, directories: boolean): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) =>
        directories ? entry.isDirectory() : entry.isFile() && entry.name.endsWith(".json"),
      )
      .map((entry) => decodeId(entry.name))
      .sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function listTsNames(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => decodeLibraryId(entry.name))
      .sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function writeTypeScript(path: string, value: string): Promise<void> {
  const result = await format(path, value);
  if (result.errors.length > 0) {
    throw new Error(
      `Cannot format ${path}: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, result.code, "utf8");
  await rename(tmp, path);
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return asRecord(value);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function asAutomation(raw: Record<string, unknown>): ComposedAutomation {
  const dependencies = Array.isArray(raw.dependencies)
    ? raw.dependencies.map(asDependency)
    : undefined;
  const actionIds = Array.isArray(raw.actionIds)
    ? raw.actionIds.filter((id): id is string => typeof id === "string")
    : dependencies?.map((dependency) => dependency.actionId);
  return {
    id: asString(raw.id, "id"),
    siteId: asString(raw.siteId, "siteId"),
    source: asString(raw.source, "source"),
    version: asNumber(raw.version, "version"),
    ...(actionIds === undefined ? {} : { actionIds }),
    ...(dependencies === undefined ? {} : { dependencies }),
  };
}

function asDependency(value: unknown): AutomationDependency {
  const raw = asRecord(value);
  if (raw === undefined) throw new Error("Stored automation dependency is invalid");
  return {
    actionId: asString(raw.actionId, "actionId"),
    actionVersion: asNumber(raw.actionVersion, "actionVersion"),
    ...(typeof raw.interfaceVersion === "number"
      ? { interfaceVersion: asNumber(raw.interfaceVersion, "interfaceVersion") }
      : {}),
    ...(raw.inputs === undefined ? {} : { inputs: asSchema(raw.inputs) }),
    ...(raw.outputs === undefined ? {} : { outputs: asSchema(raw.outputs) }),
  };
}

function asSiteAction(raw: Record<string, unknown>): SiteActionDefinition {
  const implementation = asRecord(raw.implementation);
  if (implementation === undefined || !Array.isArray(implementation.steps)) {
    throw new Error("Stored site action is missing implementation.steps");
  }
  return compileSiteAction({
    id: asString(raw.id, "id"),
    siteId: asString(raw.siteId, "siteId"),
    name: asString(raw.name, "name"),
    description: asString(raw.description, "description"),
    ...(Array.isArray(raw.aliases)
      ? { aliases: raw.aliases.filter((entry): entry is string => typeof entry === "string") }
      : {}),
    ...(Array.isArray(raw.contexts)
      ? { contexts: raw.contexts.filter((entry): entry is string => typeof entry === "string") }
      : {}),
    inputs: asSchema(raw.inputs),
    outputs: asSchema(raw.outputs),
    implementation: implementation as unknown as SiteActionDefinition["implementation"],
    ...(raw.implementations === undefined
      ? {}
      : { implementations: raw.implementations as SiteActionDefinition["implementation"][] }),
    ...(typeof raw.contractVersion === "number" ? { contractVersion: raw.contractVersion } : {}),
    ...(raw.verificationBasis === "legacy-execution" ||
    raw.verificationBasis === "condition-checked"
      ? { verificationBasis: raw.verificationBasis }
      : {}),
    safety: asSafety(raw.safety),
    version: asNumber(raw.version, "version"),
    interfaceVersion:
      typeof raw.interfaceVersion === "number"
        ? asNumber(raw.interfaceVersion, "interfaceVersion")
        : 1,
    verification: asVerification(raw.verification),
    ...(raw.runStats === undefined
      ? {}
      : {
          runStats: raw.runStats as NonNullable<SiteActionDefinition["runStats"]>,
        }),
    ...(raw.versionHistory === undefined
      ? {}
      : {
          versionHistory: raw.versionHistory as NonNullable<SiteActionDefinition["versionHistory"]>,
        }),
  });
}

function asSchema(value: unknown): SiteActionDefinition["inputs"] {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as SiteActionDefinition["inputs"];
}

function asSafety(value: unknown): SiteActionDefinition["safety"] {
  if (value === "read-only" || value === "browser-local" || value === "external-side-effect") {
    return value;
  }
  throw new Error("Stored site action is missing safety");
}

function asVerification(value: unknown): SiteActionDefinition["verification"] {
  if (value === "unverified" || value === "verified" || value === "invalid") return value;
  throw new Error("Stored site action is missing verification");
}

function asString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Stored record is missing ${field}`);
}

function asNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Stored record is missing ${field}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

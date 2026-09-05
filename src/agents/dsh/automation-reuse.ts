import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MosaikStore } from "../../persist/index.js";
import type { ComposedAutomation } from "../../automations/types.js";
import { parseAutomationImports } from "../../library/automation-imports.js";
import { normalizeSiteId } from "../../capabilities/site.js";
import { referencedActions } from "../../automations/index.js";
import type { CapabilityCompositionRequest } from "../types.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
export function automationReuseKey(request: CapabilityCompositionRequest): string {
  const { task, siteId, startUrl, inputs, safety, automationId } = request;
  return digest({ format: 1, task, siteId, startUrl, inputs, safety, automationId });
}
function cacheFile(store: MosaikStore, request: CapabilityCompositionRequest): string {
  return join(store.dataRoot, "automation-reuse", automationReuseKey(request) + ".json");
}

async function fingerprint(
  store: MosaikStore,
  automation: ComposedAutomation,
): Promise<string | undefined> {
  const actions = await store.siteActions.list(automation.siteId);
  const automations: ComposedAutomation[] = [];
  const used = new Set<string>();
  const seen = new Set<string>();
  async function visit(current: ComposedAutomation): Promise<boolean> {
    if (seen.has(current.id)) return true;
    seen.add(current.id);
    automations.push(current);
    for (const name of referencedActions(current.source)) used.add(name);
    for (const dep of current.dependencies ?? []) {
      const action = actions.find((a) => a.id === dep.actionId);
      if (
        !action ||
        action.version !== dep.actionVersion ||
        (dep.interfaceVersion !== undefined && action.interfaceVersion !== dep.interfaceVersion)
      )
        return false;
      used.add(action.name);
    }
    for (const item of parseAutomationImports(current.source)) {
      if (item.kind === "automation") {
        const child = await store.getAutomation(automation.siteId, item.automationId);
        if (!child || !(await visit(child))) return false;
      }
    }
    return true;
  }
  if (!(await visit(automation))) return undefined;
  const definitions = [];
  for (const name of [...used].sort()) {
    const action = actions.find((a) => a.name === name);
    if (!action || action.verification === "invalid") return undefined;
    const {
      runStats: _stats,
      versionHistory: _history,
      verification: _verification,
      verificationBasis: _basis,
      ...definition
    } = action;
    definitions.push(definition);
  }
  return digest({ automations, definitions });
}

export async function readReusableAutomation(
  store: MosaikStore,
  request: CapabilityCompositionRequest,
): Promise<ComposedAutomation | undefined> {
  try {
    const record = JSON.parse(await readFile(cacheFile(store, request), "utf8")) as {
      automationId: string;
      fingerprint: string;
    };
    const automation = await store.getAutomation(
      normalizeSiteId(request.siteId),
      record.automationId,
    );
    if (
      !automation ||
      (request.automationId !== undefined && automation.id !== request.automationId)
    )
      return undefined;
    return record.fingerprint === (await fingerprint(store, automation)) ? automation : undefined;
  } catch {
    return undefined;
  }
}
export async function rememberReusableAutomation(
  store: MosaikStore,
  request: CapabilityCompositionRequest,
  automation: ComposedAutomation,
): Promise<void> {
  const signature = await fingerprint(store, automation);
  if (!signature) return;
  const path = cacheFile(store, request);
  await mkdir(join(store.dataRoot, "automation-reuse"), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(
      temporary,
      JSON.stringify({ automationId: automation.id, fingerprint: signature }),
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function forgetReusableAutomation(
  store: MosaikStore,
  request: CapabilityCompositionRequest,
): Promise<void> {
  await rm(cacheFile(store, request), { force: true });
}

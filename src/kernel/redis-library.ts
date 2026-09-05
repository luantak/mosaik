import { createClient, type RedisClientType } from "redis";
import {
  assertSiteCapability,
  compileSiteAction,
  normalizeSiteId,
  type SiteActionDefinition,
} from "../capabilities/index.js";
import { assertMosaikAutomation } from "../capabilities/code-mode.js";
import type { RemoteLibraryBackend, RemoteLibraryWriteResult } from "../persist/index.js";
import type { ComposedAutomation } from "../automations/types.js";

const WRITE_ACTION_SCRIPT = `
local current = redis.call("HGET", KEYS[1], ARGV[2])
local claimed = redis.call("HGET", KEYS[2], ARGV[3])
local indexedSite = redis.call("HGET", KEYS[4], ARGV[2])
if indexedSite and indexedSite ~= ARGV[1] then return "conflict" end
if claimed and claimed ~= ARGV[2] then return "name-conflict" end
if current == ARGV[4] then return "unchanged" end
if current then
  local decoded = cjson.decode(current)
  if ARGV[5] == "" or tonumber(ARGV[5]) ~= tonumber(decoded.version) then return "conflict" end
  if decoded.name ~= ARGV[3] and redis.call("HGET", KEYS[2], decoded.name) == ARGV[2] then
    redis.call("HDEL", KEYS[2], decoded.name)
  end
elseif ARGV[5] ~= "" then
  return "conflict"
end
redis.call("HSET", KEYS[1], ARGV[2], ARGV[4])
redis.call("HSET", KEYS[2], ARGV[3], ARGV[2])
redis.call("HSET", KEYS[4], ARGV[2], ARGV[1])
redis.call("SADD", KEYS[3], ARGV[1])
return "stored"
`;

const WRITE_AUTOMATION_SCRIPT = `
local current = redis.call("HGET", KEYS[1], ARGV[2])
if current == ARGV[3] then return "unchanged" end
if current then
  local decoded = cjson.decode(current)
  local incoming = cjson.decode(ARGV[3])
  if ARGV[4] == "" or tonumber(ARGV[4]) ~= tonumber(decoded.version) then return "conflict" end
  if tonumber(incoming.version) <= tonumber(decoded.version) then return "conflict" end
elseif ARGV[4] ~= "" then
  return "conflict"
end
redis.call("HSET", KEYS[1], ARGV[2], ARGV[3])
redis.call("SADD", KEYS[2], ARGV[1])
return "stored"
`;

export async function openRedisLibraryBackend(input: {
  url: string;
  namespace?: string;
}): Promise<RemoteLibraryBackend> {
  const client = createClient({
    url: input.url,
    socket: { connectTimeout: 5_000 },
  });
  client.on("error", () => undefined);
  await client.connect();
  return new RedisLibraryBackend(client, normalizeNamespace(input.namespace));
}

class RedisLibraryBackend implements RemoteLibraryBackend {
  constructor(
    private readonly client: RedisClientType,
    private readonly prefix: string,
  ) {}

  async listSites(): Promise<string[]> {
    return (await this.client.sMembers(this.sitesKey())).map(normalizeSiteId).sort();
  }

  async listActions(siteId: string): Promise<SiteActionDefinition[]> {
    const values = await this.client.hVals(this.actionsKey(siteId));
    return values.map(parseAction).sort((left, right) => left.name.localeCompare(right.name));
  }

  async findAction(actionId: string): Promise<SiteActionDefinition | undefined> {
    const siteId = await this.client.hGet(this.actionIndexKey(), actionId);
    if (siteId === null) return undefined;
    const value = await this.client.hGet(this.actionsKey(siteId), actionId);
    return value === null ? undefined : parseAction(value);
  }

  async writeAction(
    action: SiteActionDefinition,
    expectedVersion: number | undefined,
  ): Promise<RemoteLibraryWriteResult> {
    const compiled = compileSiteAction(action);
    assertSiteCapability(compiled);
    const siteId = normalizeSiteId(compiled.siteId);
    const result = await this.client.eval(WRITE_ACTION_SCRIPT, {
      keys: [
        this.actionsKey(siteId),
        this.actionNamesKey(siteId),
        this.sitesKey(),
        this.actionIndexKey(),
      ],
      arguments: [
        siteId,
        compiled.id,
        compiled.name,
        JSON.stringify(compiled),
        expectedVersion === undefined ? "" : String(expectedVersion),
      ],
    });
    return asWriteResult(result);
  }

  async listAutomations(siteId: string): Promise<ComposedAutomation[]> {
    const normalized = normalizeSiteId(siteId);
    const values = await this.client.hVals(this.automationsKey(normalized));
    return values.map((value) => parseAutomation(value, normalized));
  }

  async getAutomation(
    siteId: string,
    automationId: string,
  ): Promise<ComposedAutomation | undefined> {
    const normalized = normalizeSiteId(siteId);
    const value = await this.client.hGet(this.automationsKey(normalized), automationId);
    return value === null ? undefined : parseAutomation(value, normalized);
  }

  async writeAutomation(
    automation: ComposedAutomation,
    expectedVersion: number | undefined,
  ): Promise<RemoteLibraryWriteResult> {
    const siteId = normalizeSiteId(automation.siteId);
    const compiled = parseAutomation(JSON.stringify({ ...automation, siteId }), siteId);
    const result = await this.client.eval(WRITE_AUTOMATION_SCRIPT, {
      keys: [this.automationsKey(siteId), this.sitesKey()],
      arguments: [
        siteId,
        compiled.id,
        JSON.stringify(compiled),
        expectedVersion === undefined ? "" : String(expectedVersion),
      ],
    });
    return asWriteResult(result);
  }

  async clear(): Promise<void> {
    const keys: string[] = [];
    for await (const batch of this.client.scanIterator({
      MATCH: `${this.prefix}:*`,
      COUNT: 100,
    })) {
      keys.push(...batch);
      if (keys.length >= 100) await this.deleteKeys(keys);
    }
    await this.deleteKeys(keys);
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.sendCommand(["DEL", ...keys.splice(0, keys.length)]);
  }

  private sitesKey(): string {
    return `${this.prefix}:sites`;
  }

  private actionIndexKey(): string {
    return `${this.prefix}:action-sites`;
  }

  private actionsKey(siteId: string): string {
    return `${this.prefix}:site:${encodeURIComponent(normalizeSiteId(siteId))}:actions`;
  }

  private actionNamesKey(siteId: string): string {
    return `${this.prefix}:site:${encodeURIComponent(normalizeSiteId(siteId))}:action-names`;
  }

  private automationsKey(siteId: string): string {
    return `${this.prefix}:site:${encodeURIComponent(normalizeSiteId(siteId))}:automations`;
  }
}

function parseAction(value: string): SiteActionDefinition {
  const parsed: unknown = JSON.parse(value);
  const action = compileSiteAction(parsed as SiteActionDefinition);
  assertSiteCapability(action);
  return action;
}

function parseAutomation(value: string, expectedSiteId: string): ComposedAutomation {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Remote automation must be an object");
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) {
    throw new Error("Remote automation id is required");
  }
  if (typeof raw.siteId !== "string" || normalizeSiteId(raw.siteId) !== expectedSiteId) {
    throw new Error(`Remote automation ${raw.id} belongs to a different site`);
  }
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1) {
    throw new Error(`Remote automation ${raw.id} has an invalid version`);
  }
  if (typeof raw.source !== "string") throw new Error(`Remote automation ${raw.id} needs source`);
  assertMosaikAutomation(raw.source);
  return parsed as ComposedAutomation;
}

function asWriteResult(value: unknown): RemoteLibraryWriteResult {
  if (
    value === "stored" ||
    value === "unchanged" ||
    value === "conflict" ||
    value === "name-conflict"
  ) {
    return value;
  }
  throw new Error(`Unexpected Redis library response: ${String(value)}`);
}

function normalizeNamespace(value: string | undefined): string {
  const namespace = value?.trim() || "mosaik:v1";
  if (!/^[A-Za-z0-9:_-]+$/.test(namespace)) {
    throw new Error(
      "MOSAIK_LIBRARY_NAMESPACE may contain letters, numbers, colons, dashes, and underscores",
    );
  }
  return namespace;
}

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { domainMatches, normalizeDomain } from "./kernel/hosted-login.js";

export interface InteractiveCliHistory {
  urls: string[];
  prompts: string[];
}

const HISTORY_LIMIT = 100;

export interface KernelAuthConnection {
  domain: string;
  loginUrl: string;
  connectionId: string;
  profileName: string;
}

export interface MosaikConfig {
  version: 1;
  browser?: "local" | "kernel";
  humanize?: boolean;
  kernel?: {
    connections: Record<string, KernelAuthConnection>;
  };
}

export function mosaikConfigPath(dataDirectory: string): string {
  return resolve(dataDirectory, "config.json");
}

export async function loadMosaikConfig(dataDirectory: string): Promise<MosaikConfig> {
  const path = mosaikConfigPath(dataDirectory);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Invalid Mosaik config JSON in ${path}`);
  }
  try {
    return validateMosaikConfig(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Mosaik config in ${path}: ${message}`);
  }
}

export async function saveDefaultBrowser(
  dataDirectory: string,
  browser: "local" | "kernel",
): Promise<string> {
  const config = await loadMosaikConfig(dataDirectory);
  return saveMosaikConfig(dataDirectory, { ...config, browser });
}

export async function saveHumanizationDefault(
  dataDirectory: string,
  humanize: boolean,
): Promise<string> {
  const config = await loadMosaikConfig(dataDirectory);
  return saveMosaikConfig(dataDirectory, { ...config, humanize });
}

export function resolveMosaikBrowser(
  explicit: "local" | "kernel" | undefined,
  config: MosaikConfig,
): "local" | "kernel" {
  return explicit ?? config.browser ?? "local";
}

export function resolveHumanization(explicit: boolean | undefined, config: MosaikConfig): boolean {
  return explicit ?? config.humanize ?? false;
}

export function findKernelAuthConnection(
  config: MosaikConfig,
  targetUrl: string,
): KernelAuthConnection | undefined {
  const target = webUrl(targetUrl);
  const candidates = Object.values(config.kernel?.connections ?? {}).filter((connection) =>
    domainMatches(target.hostname, connection.domain),
  );
  candidates.sort((left, right) => right.domain.length - left.domain.length);
  return candidates[0];
}

export async function saveKernelAuthConnection(
  dataDirectory: string,
  connection: KernelAuthConnection,
): Promise<string> {
  const config = await loadMosaikConfig(dataDirectory);
  const normalized = validateKernelAuthConnection(connection, "connection");
  return saveMosaikConfig(dataDirectory, {
    ...config,
    kernel: {
      connections: {
        ...config.kernel?.connections,
        [normalized.domain]: normalized,
      },
    },
  });
}

async function saveMosaikConfig(dataDirectory: string, config: MosaikConfig): Promise<string> {
  const path = mosaikConfigPath(dataDirectory);
  const directory = resolve(dataDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return path;
}

function validateMosaikConfig(value: unknown): MosaikConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("the root must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("version must be 1");
  if (record.browser !== undefined && record.browser !== "local" && record.browser !== "kernel") {
    throw new Error("browser must be local or kernel");
  }
  if (record.humanize !== undefined && typeof record.humanize !== "boolean") {
    throw new Error("humanize must be a boolean");
  }
  if (record.kernel === undefined) {
    return {
      version: 1,
      ...(record.browser === undefined ? {} : { browser: record.browser }),
      ...(record.humanize === undefined ? {} : { humanize: record.humanize }),
    };
  }
  if (record.kernel === null || typeof record.kernel !== "object" || Array.isArray(record.kernel)) {
    throw new Error("kernel must be an object");
  }
  const rawConnections = (record.kernel as Record<string, unknown>).connections;
  if (
    rawConnections === null ||
    typeof rawConnections !== "object" ||
    Array.isArray(rawConnections)
  ) {
    throw new Error("kernel.connections must be an object");
  }
  const connections: Record<string, KernelAuthConnection> = {};
  for (const [key, valueForKey] of Object.entries(rawConnections)) {
    const connection = validateKernelAuthConnection(valueForKey, `kernel connection ${key}`);
    if (key !== connection.domain)
      throw new Error(`kernel connection key must be ${connection.domain}`);
    connections[key] = connection;
  }
  return {
    version: 1,
    ...(record.browser === undefined ? {} : { browser: record.browser }),
    ...(record.humanize === undefined ? {} : { humanize: record.humanize }),
    kernel: { connections },
  };
}

function validateKernelAuthConnection(value: unknown, label: string): KernelAuthConnection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const domain = normalizeDomain(requiredString(record.domain, `${label}.domain`));
  const loginUrl = webUrl(requiredString(record.loginUrl, `${label}.loginUrl`)).href;
  const connectionId = requiredString(record.connectionId, `${label}.connectionId`);
  const profileName = requiredString(record.profileName, `${label}.profileName`);
  if (!/^[^\s]{1,256}$/.test(connectionId)) throw new Error(`${label}.connectionId is invalid`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(profileName)) {
    throw new Error(`${label}.profileName is invalid`);
  }
  return { domain, loginUrl, connectionId, profileName };
}

function webUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`URL is invalid: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must use http or https");
  }
  if (parsed.hostname.length === 0 || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("URL must be a web URL without credentials");
  }
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} is required`);
  return value.trim();
}

export async function loadInteractiveCliHistory(
  workingDirectory: string,
): Promise<InteractiveCliHistory> {
  try {
    const value: unknown = JSON.parse(
      await readFile(resolve(workingDirectory, ".mosaik", "history.json"), "utf8"),
    );
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { urls: [], prompts: [] };
    }
    const record = value as Record<string, unknown>;
    return {
      urls: historyEntries(record.urls),
      prompts: historyEntries(record.prompts),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return { urls: [], prompts: [] };
    }
    throw error;
  }
}

export async function saveInteractiveCliHistory(
  workingDirectory: string,
  history: InteractiveCliHistory,
): Promise<string> {
  const directory = resolve(workingDirectory, ".mosaik");
  const path = resolve(directory, "history.json");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        urls: historyEntries(history.urls),
        prompts: historyEntries(history.prompts),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  if (process.platform !== "win32") await chmod(path, 0o600);
  return path;
}

export function rememberInteractiveHistory(entries: string[], value: string): string[] {
  const normalized = value.trim();
  if (normalized.length === 0) return historyEntries(entries);
  return [...entries.filter((entry) => entry !== normalized), normalized].slice(-HISTORY_LIMIT);
}

function historyEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(-HISTORY_LIMIT);
}

export async function saveOpenRouterKey(key: string, workingDirectory: string): Promise<string> {
  if (key.trim().length === 0) throw new Error("The provider key cannot be empty");
  const path = resolve(workingDirectory, ".env");
  let source = "";
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const assignment = `OPENROUTER_API_KEY=${key.trim()}`;
  const lines = source.split("\n");
  const index = lines.findIndex((line) => /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=/.test(line));
  let contents: string;
  if (index < 0) {
    contents = `${source}${source.length === 0 || source.endsWith("\n") ? "" : "\n"}${assignment}\n`;
  } else {
    lines[index] = assignment;
    contents = lines.join("\n");
    if (!contents.endsWith("\n")) contents += "\n";
  }
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
  process.env.OPENROUTER_API_KEY = key.trim();
  return path;
}

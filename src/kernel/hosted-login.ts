import { randomUUID } from "node:crypto";

export interface KernelHostedLoginRequest {
  domain: string;
  profileName?: string;
  loginUrl?: string;
  allowedDomains?: string[];
}

export type KernelHostedLoginStart =
  | {
      status: "authenticated";
      connectionId: string;
      profileName: string;
    }
  | {
      status: "login-required";
      connectionId: string;
      profileName: string;
      hostedUrl: string;
      expiresAt: string;
    };

export type KernelHostedLoginStatus =
  | { status: "pending"; connectionId: string; expiresAt?: string }
  | { status: "authenticated"; connectionId: string }
  | {
      status: "failed" | "expired" | "canceled";
      connectionId: string;
      message?: string;
    };

export interface KernelAuthConnectionClient {
  auth: {
    connections: {
      list(query?: { domain?: string; profile_name?: string }): unknown;
      retrieve(id: string): unknown;
      create(body: KernelAuthConnectionCreateRequest): unknown;
      login(id: string): unknown;
    };
  };
}

interface KernelAuthConnectionCreateRequest {
  domain: string;
  profile_name: string;
  login_url?: string;
  allowed_domains?: string[];
  health_checks?: boolean;
  auto_reauth?: boolean;
  save_credentials?: boolean;
  browser?: { stealth?: boolean };
}

interface AuthConnection {
  id: string;
  domain: string;
  profileName: string;
  status: "AUTHENTICATED" | "NEEDS_AUTH";
  flowStatus?: "IN_PROGRESS" | "SUCCESS" | "FAILED" | "EXPIRED" | "CANCELED";
  flowExpiresAt?: string;
  hostedUrl?: string;
  errorMessage?: string;
}

export async function startKernelHostedLogin(
  client: KernelAuthConnectionClient,
  request: KernelHostedLoginRequest,
): Promise<KernelHostedLoginStart> {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Kernel hosted login request must be an object");
  }
  if (typeof request.domain !== "string") throw new Error("domain is required");
  if (request.loginUrl !== undefined && typeof request.loginUrl !== "string") {
    throw new Error("loginUrl must be a string");
  }
  if (request.profileName !== undefined && typeof request.profileName !== "string") {
    throw new Error("profileName must be a string");
  }
  if (
    request.allowedDomains !== undefined &&
    (!Array.isArray(request.allowedDomains) ||
      request.allowedDomains.some((value) => typeof value !== "string"))
  ) {
    throw new Error("allowedDomains must be an array of strings");
  }
  const domain = normalizeDomain(request.domain, "domain");
  const loginUrl = request.loginUrl === undefined ? undefined : normalizeWebUrl(request.loginUrl);
  const allowedDomains =
    request.allowedDomains === undefined
      ? undefined
      : [...new Set(request.allowedDomains.map((value) => normalizeAllowedDomain(value)))];
  const profileName = request.profileName ?? `mosaik-${randomUUID()}`;
  validateProfileName(profileName);

  const list = () => listConnections(client, { domain, profile_name: profileName });
  let connection = (await list())[0];
  if (connection === undefined) {
    try {
      connection = await createConnection(client, {
        domain,
        profile_name: profileName,
        ...(loginUrl === undefined ? {} : { login_url: loginUrl.href }),
        ...(allowedDomains === undefined ? {} : { allowed_domains: allowedDomains }),
        health_checks: true,
        auto_reauth: true,
        save_credentials: true,
        browser: { stealth: true },
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      connection = (await list())[0];
      if (connection === undefined) throw error;
    }
  }

  if (connection.status === "AUTHENTICATED") {
    return {
      status: "authenticated",
      connectionId: connection.id,
      profileName: connection.profileName,
    };
  }

  if (
    connection.flowStatus === "IN_PROGRESS" &&
    connection.hostedUrl !== undefined &&
    connection.flowExpiresAt !== undefined &&
    !isExpired(connection.flowExpiresAt)
  ) {
    return {
      status: "login-required",
      connectionId: connection.id,
      profileName: connection.profileName,
      hostedUrl: connection.hostedUrl,
      expiresAt: connection.flowExpiresAt,
    };
  }

  const login = parseLoginResponse(await client.auth.connections.login(connection.id));
  return {
    status: "login-required",
    connectionId: connection.id,
    profileName: connection.profileName,
    hostedUrl: login.hostedUrl,
    expiresAt: login.expiresAt,
  };
}

export async function getKernelHostedLoginStatus(
  client: KernelAuthConnectionClient,
  connectionId: string,
): Promise<KernelHostedLoginStatus> {
  validateConnectionId(connectionId);
  const connection = parseConnection(await client.auth.connections.retrieve(connectionId));
  if (connection.status === "AUTHENTICATED") {
    return { status: "authenticated", connectionId: connection.id };
  }
  switch (connection.flowStatus) {
    case "FAILED":
      return {
        status: "failed",
        connectionId: connection.id,
        ...(connection.errorMessage === undefined
          ? {}
          : { message: boundedMessage(connection.errorMessage) }),
      };
    case "EXPIRED":
      return { status: "expired", connectionId: connection.id };
    case "CANCELED":
      return { status: "canceled", connectionId: connection.id };
    default:
      return {
        status: "pending",
        connectionId: connection.id,
        ...(connection.flowExpiresAt === undefined ? {} : { expiresAt: connection.flowExpiresAt }),
      };
  }
}

export async function requireAuthenticatedKernelProfile(
  client: KernelAuthConnectionClient,
  connectionId: string,
  targetUrl: string,
): Promise<string> {
  validateConnectionId(connectionId);
  const target = normalizeWebUrl(targetUrl);
  const connection = parseConnection(await client.auth.connections.retrieve(connectionId));
  if (connection.status !== "AUTHENTICATED") {
    throw new Error("Kernel auth connection is not authenticated");
  }
  if (!domainMatches(target.hostname, connection.domain)) {
    throw new Error(`Kernel auth connection does not permit ${target.hostname}`);
  }
  return connection.profileName;
}

export function normalizeDomain(value: string, label = "domain"): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const source = value.trim();
  if (source.length === 0) throw new Error(`${label} is required`);
  let parsed: URL;
  try {
    parsed = new URL(source.includes("://") ? source : `https://${source}`);
  } catch {
    throw new Error(`${label} is not a valid hostname`);
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(`${label} must be a hostname`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname.length === 0 || hostname.includes("..")) {
    throw new Error(`${label} is not a valid hostname`);
  }
  return hostname;
}

export function domainMatches(hostname: string, domain: string): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");
  const normalizedDomain = normalizeDomain(domain);
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function normalizeAllowedDomain(value: string): string {
  return normalizeDomain(value.replace(/^\*\./, ""), "allowed domain").replace(/^www\./, "");
}

function normalizeWebUrl(value: string): URL {
  if (typeof value !== "string") throw new Error("The URL must be a string");
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`The URL is not valid: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The URL must use http or https");
  }
  if (parsed.hostname.length === 0 || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("The URL must be a web URL without credentials");
  }
  return parsed;
}

async function listConnections(
  client: KernelAuthConnectionClient,
  query: { domain: string; profile_name: string },
): Promise<AuthConnection[]> {
  const result = client.auth.connections.list(query);
  const values =
    result !== null && typeof result === "object" && Symbol.asyncIterator in result
      ? await collectPage(result)
      : await collectPage(await Promise.resolve(result));
  return values.map((value) => parseConnection(value));
}

async function collectPage(value: unknown): Promise<unknown[]> {
  if (value !== null && typeof value === "object" && Symbol.asyncIterator in value) {
    const values: unknown[] = [];
    for await (const item of value as AsyncIterable<unknown>) values.push(item);
    return values;
  }
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object" && "data" in value) {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  throw new Error("Kernel returned a malformed auth connection list");
}

async function createConnection(
  client: KernelAuthConnectionClient,
  body: KernelAuthConnectionCreateRequest,
): Promise<AuthConnection> {
  return parseConnection(await client.auth.connections.create(body));
}

function parseConnection(value: unknown): AuthConnection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kernel returned a malformed auth connection");
  }
  const record = value as Record<string, unknown>;
  const id = requiredString(record.id, "auth connection ID");
  validateConnectionId(id);
  const domain = normalizeDomain(requiredString(record.domain, "auth connection domain"));
  const profileName = requiredString(record.profile_name, "auth connection profile");
  validateProfileName(profileName);
  if (record.status !== "AUTHENTICATED" && record.status !== "NEEDS_AUTH") {
    throw new Error("Kernel returned a malformed auth connection status");
  }
  const flowStatus = optionalEnum(record.flow_status, [
    "IN_PROGRESS",
    "SUCCESS",
    "FAILED",
    "EXPIRED",
    "CANCELED",
  ] as const);
  const flowExpiresAt = optionalString(record.flow_expires_at);
  const hostedUrl = optionalString(record.hosted_url);
  const errorMessage = optionalString(record.error_message);
  if (flowExpiresAt !== undefined && Number.isNaN(Date.parse(flowExpiresAt))) {
    throw new Error("Kernel returned a malformed auth flow expiry");
  }
  if (hostedUrl !== undefined) normalizeWebUrl(hostedUrl);
  return {
    id,
    domain,
    profileName,
    status: record.status,
    ...(flowStatus === undefined ? {} : { flowStatus }),
    ...(flowExpiresAt === undefined ? {} : { flowExpiresAt }),
    ...(hostedUrl === undefined ? {} : { hostedUrl }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function parseLoginResponse(value: unknown): { hostedUrl: string; expiresAt: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kernel returned a malformed hosted login response");
  }
  const record = value as Record<string, unknown>;
  const hostedUrl = requiredString(record.hosted_url, "hosted login URL");
  const expiresAt = requiredString(record.flow_expires_at, "hosted login expiry");
  normalizeWebUrl(hostedUrl);
  if (Number.isNaN(Date.parse(expiresAt)))
    throw new Error("Kernel returned a malformed login expiry");
  return { hostedUrl, expiresAt };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Kernel returned a malformed ${label}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : requiredString(value, "field");
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!allowed.includes(value as T[number]))
    throw new Error("Kernel returned a malformed auth flow status");
  return value as T[number];
}

function validateProfileName(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Kernel profile name must use letters, numbers, dots, underscores, or hyphens");
  }
}

function validateConnectionId(value: string): void {
  if (typeof value !== "string" || !/^[^\s]{1,256}$/.test(value)) {
    throw new Error("Kernel auth connection ID is invalid");
  }
}

function isExpired(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) || timestamp <= Date.now();
}

function boundedMessage(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 500);
}

function isConflict(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const status = "status" in error ? (error as { status?: unknown }).status : undefined;
  return status === 409;
}

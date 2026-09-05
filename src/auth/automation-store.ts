import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LocatorDefinition, LocatorScope } from "../core/index.js";
import type { AuthSuccessCondition } from "./types.js";

export const PROFILE_AUTH_AUTOMATIONS_FILENAME = ".mosaik-auth-automations.json";

interface AuthAutomationFile {
  version: 1;
  logins: Record<string, AuthSuccessCondition>;
}

export async function loadProfileAuthAutomation(
  profileDirectory: string,
  loginUrl: string,
): Promise<AuthSuccessCondition | undefined> {
  const file = await readAutomationFile(profileDirectory);
  return file.logins[normalizeLoginUrl(loginUrl)];
}

export async function saveProfileAuthAutomation(
  profileDirectory: string,
  condition: AuthSuccessCondition,
): Promise<void> {
  const file = await readAutomationFile(profileDirectory);
  file.logins[normalizeLoginUrl(condition.loginUrl)] = condition;
  await writeAutomationFile(profileDirectory, file);
}

export function profileAuthAutomationsPath(profileDirectory: string): string {
  return join(profileDirectory, PROFILE_AUTH_AUTOMATIONS_FILENAME);
}

async function readAutomationFile(profileDirectory: string): Promise<AuthAutomationFile> {
  const path = profileAuthAutomationsPath(profileDirectory);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return emptyAutomationFile();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Saved authentication automations at ${path} are not valid JSON`);
  }
  if (!isAutomationFile(parsed)) {
    throw new Error(`Saved authentication automations at ${path} use an unsupported format`);
  }
  return parsed;
}

async function writeAutomationFile(
  profileDirectory: string,
  file: AuthAutomationFile,
): Promise<void> {
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(profileDirectory, 0o700);
  const path = profileAuthAutomationsPath(profileDirectory);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
}

function emptyAutomationFile(): AuthAutomationFile {
  return { version: 1, logins: {} };
}

function normalizeLoginUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

function isAutomationFile(value: unknown): value is AuthAutomationFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isRecord(value.logins) &&
    Object.values(value.logins).every(isAuthSuccessCondition)
  );
}

function isAuthSuccessCondition(value: unknown): value is AuthSuccessCondition {
  return (
    isRecord(value) &&
    typeof value.loginUrl === "string" &&
    isWebUrl(value.loginUrl) &&
    typeof value.targetUrl === "string" &&
    isWebUrl(value.targetUrl) &&
    typeof value.requireAuthFormAbsent === "boolean" &&
    (value.confidence === "high" || value.confidence === "medium" || value.confidence === "low") &&
    typeof value.reason === "string" &&
    (value.marker === undefined || isAuthSuccessMarker(value.marker))
  );
}

function isAuthSuccessMarker(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.candidateId === "string" &&
    typeof value.description === "string" &&
    isLocator(value.locator)
  );
}

function isLocator(value: unknown): value is LocatorDefinition {
  if (!isRecord(value) || !isScope(value.within)) return false;
  if (value.strategy === "role") {
    return (
      typeof value.role === "string" &&
      (value.name === undefined || typeof value.name === "string") &&
      (value.exact === undefined || typeof value.exact === "boolean")
    );
  }
  if (value.strategy === "text") {
    return (
      typeof value.text === "string" &&
      (value.exact === undefined || typeof value.exact === "boolean")
    );
  }
  if (value.strategy === "label") {
    return (
      typeof value.label === "string" &&
      (value.exact === undefined || typeof value.exact === "boolean")
    );
  }
  if (value.strategy === "test-id") return typeof value.testId === "string";
  return value.strategy === "css" && typeof value.selector === "string";
}

function isScope(value: unknown): value is LocatorScope | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.kind === "form") return typeof value.name === "string";
  return (
    value.kind === "landmark" &&
    typeof value.role === "string" &&
    (value.name === undefined || typeof value.name === "string")
  );
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

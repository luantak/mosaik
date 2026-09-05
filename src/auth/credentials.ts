import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthChallenge, AuthField, CredentialPrompter } from "./types.js";

export const PROFILE_CREDENTIALS_FILENAME = ".mosaik-credentials.json";

interface StoredCredential {
  kind: AuthField["kind"];
  label: string;
  autocomplete?: string;
  value: string;
}

interface StoredChallenge {
  url: string;
  fields: Record<string, StoredCredential>;
}

interface CredentialFile {
  version: 1;
  challenges: Record<string, StoredChallenge>;
}

/**
 * Reuses raw credentials stored inside a persistent browser profile. The
 * fallback prompt is called for new, missing, one-time, or previously rejected
 * values. One-time codes are never stored.
 */
export function createProfileCredentialPrompter(
  profileDirectory: string,
  fallback: CredentialPrompter,
): CredentialPrompter {
  const attemptedChallenges = new Set<string>();

  return {
    async prompt(challenge) {
      const challengeKey = identifyChallenge(challenge);
      const repeated = attemptedChallenges.has(challengeKey);
      attemptedChallenges.add(challengeKey);

      const credentialFile = await readCredentialFile(profileDirectory);
      const stored = credentialFile.challenges[challengeKey];
      const values: Record<string, string> = {};
      const fieldsToPrompt: AuthField[] = [];

      for (const [index, field] of challenge.fields.entries()) {
        const saved = stored?.fields[identifyField(field, index)];
        if (
          !repeated &&
          field.kind !== "one-time-code" &&
          saved !== undefined &&
          saved.kind === field.kind
        ) {
          values[field.id] = saved.value;
        } else {
          fieldsToPrompt.push(field);
        }
      }

      let prompted: Record<string, string> = {};
      if (fieldsToPrompt.length > 0) {
        prompted = await fallback.prompt({ ...challenge, fields: fieldsToPrompt });
        Object.assign(values, prompted);
      }

      const savedFields = repeated ? {} : { ...stored?.fields };
      let changed = stored === undefined || repeated;
      for (const [index, field] of challenge.fields.entries()) {
        if (field.kind === "one-time-code") continue;
        const value = values[field.id];
        if (value === undefined) continue;
        const fieldKey = identifyField(field, index);
        if (prompted[field.id] !== undefined || savedFields[fieldKey] === undefined) {
          savedFields[fieldKey] = {
            kind: field.kind,
            label: field.label,
            ...(field.autocomplete === undefined ? {} : { autocomplete: field.autocomplete }),
            value,
          };
          changed = true;
        }
      }

      if (changed) {
        credentialFile.challenges[challengeKey] = {
          url: normalizeUrl(challenge.url),
          fields: savedFields,
        };
        await writeCredentialFile(profileDirectory, credentialFile);
      }

      return values;
    },
  };
}

export function profileCredentialsPath(profileDirectory: string): string {
  return join(profileDirectory, PROFILE_CREDENTIALS_FILENAME);
}

function identifyChallenge(challenge: Readonly<AuthChallenge>): string {
  const identity = {
    url: normalizeUrl(challenge.url),
    fields: challenge.fields.map((field, index) => identifyField(field, index)),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24);
}

function identifyField(field: Readonly<AuthField>, index: number): string {
  return [
    index,
    field.kind,
    normalizeText(field.autocomplete ?? ""),
    normalizeText(field.label),
  ].join(":");
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.href;
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

async function readCredentialFile(profileDirectory: string): Promise<CredentialFile> {
  const path = profileCredentialsPath(profileDirectory);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return emptyCredentialFile();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Saved credentials at ${path} are not valid JSON`);
  }
  if (!isCredentialFile(parsed)) {
    throw new Error(`Saved credentials at ${path} use an unsupported format`);
  }
  return parsed;
}

async function writeCredentialFile(
  profileDirectory: string,
  credentialFile: CredentialFile,
): Promise<void> {
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(profileDirectory, 0o700);
  const path = profileCredentialsPath(profileDirectory);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(credentialFile, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
}

function emptyCredentialFile(): CredentialFile {
  return { version: 1, challenges: {} };
}

function isCredentialFile(value: unknown): value is CredentialFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.challenges)) return false;
  return Object.values(value.challenges).every(
    (challenge) =>
      isRecord(challenge) &&
      typeof challenge.url === "string" &&
      isRecord(challenge.fields) &&
      Object.values(challenge.fields).every(isStoredCredential),
  );
}

function isStoredCredential(value: unknown): value is StoredCredential {
  return (
    isRecord(value) &&
    (value.kind === "username" || value.kind === "password" || value.kind === "text") &&
    typeof value.label === "string" &&
    (value.autocomplete === undefined || typeof value.autocomplete === "string") &&
    typeof value.value === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

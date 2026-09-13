import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type {
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import { parseDocument, YAMLMap } from "yaml";
import { resolveLlmRoute, type LlmRoute } from "../agents/dsh/llm-route.js";

export const OPENAI_CODEX_CREDENTIAL_KEY = "llm-pi-ai/openai-codex";

export interface OpenAICodexGrant extends OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

export interface OpenAICodexStatus {
  signedIn: boolean;
  path: string;
}

export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_HOME?.trim();
  return override !== undefined && override.length > 0 ? override : join(homedir(), ".dsh");
}

export function dshCredentialsPath(home = dshHome()): string {
  return join(home, ".credentials.yaml");
}

export async function readOpenAICodexGrant(
  home = dshHome(),
): Promise<OpenAICodexGrant | undefined> {
  const path = dshCredentialsPath(home);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`Invalid DSH credentials YAML in ${path}`);
  }
  const record = toJson(document.getIn(["records", OPENAI_CODEX_CREDENTIAL_KEY]));
  if (typeof record !== "object" || record === null) return undefined;
  const payload = (record as { payload?: unknown }).payload;
  return asGrant(payload, path);
}

export async function writeOpenAICodexGrant(
  grant: OpenAICodexGrant,
  home = dshHome(),
): Promise<string> {
  const path = dshCredentialsPath(home);
  await mkdir(home, { recursive: true, mode: 0o700 });
  let source = "";
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const document =
    source.trim().length === 0 ? parseDocument("version: 1\nrecords: {}\n") : parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`Invalid DSH credentials YAML in ${path}`);
  }
  if (document.get("version") === undefined) document.set("version", 1);
  if (!(document.get("records") instanceof YAMLMap)) document.set("records", new YAMLMap());
  const records = document.get("records");
  if (!(records instanceof YAMLMap)) {
    throw new Error(`Invalid DSH credentials YAML in ${path}: records must be a mapping`);
  }
  records.set(OPENAI_CODEX_CREDENTIAL_KEY, {
    kind: "grant",
    payload: {
      type: "oauth",
      access: grant.access,
      refresh: grant.refresh,
      expires: grant.expires,
      accountId: grant.accountId,
    },
  });
  await writeFile(path, document.toString(), { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(home, 0o700);
    await chmod(path, 0o600);
  }
  return path;
}

export async function deleteOpenAICodexGrant(
  home = dshHome(),
): Promise<{ path: string; deleted: boolean }> {
  const path = dshCredentialsPath(home);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, deleted: false };
    throw error;
  }
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`Invalid DSH credentials YAML in ${path}`);
  }
  const records = document.get("records");
  if (!(records instanceof YAMLMap) || !records.has(OPENAI_CODEX_CREDENTIAL_KEY)) {
    return { path, deleted: false };
  }
  records.delete(OPENAI_CODEX_CREDENTIAL_KEY);
  await writeFile(path, document.toString(), { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
  return { path, deleted: true };
}

export async function openaiCodexStatus(home = dshHome()): Promise<OpenAICodexStatus> {
  const path = dshCredentialsPath(home);
  if ((await readOpenAICodexGrant(home)) !== undefined) {
    return { signedIn: true, path };
  }
  return { signedIn: false, path };
}

export async function loginOpenAICodexOAuth(
  options: { dshHome?: string; interaction?: AuthInteraction } = {},
): Promise<{ path: string; accountId: string }> {
  const home = options.dshHome ?? dshHome();
  const store = dshCodexCredentialStore(home);
  const models = createModels({ credentials: store });
  models.setProvider(openaiCodexProvider());
  const session = options.interaction === undefined ? terminalOAuthInteraction() : undefined;
  const interaction = options.interaction ?? session?.interaction;
  if (interaction === undefined) throw new Error("OpenAI Codex login needs an interaction");
  try {
    const credential = await models.login("openai-codex", "oauth", interaction);
    const grant = asGrant(credential, "OpenAI Codex OAuth");
    const path = await writeOpenAICodexGrant(grant, home);
    return { path, accountId: grant.accountId };
  } finally {
    session?.close();
  }
}

export function requireOpenAICodexGrantMessage(home = dshHome()): string {
  return `OpenAI Codex is not signed in. Run \`mosaik provider login\`. Credentials are stored in ${dshCredentialsPath(home)}.`;
}

export async function assertLlmCredentials(model?: string, home = dshHome()): Promise<LlmRoute> {
  const route = resolveLlmRoute(model);
  if (route.provider === "opencode-go") {
    if (!process.env.OPENCODE_API_KEY)
      throw new Error("OPENCODE_API_KEY is required for OpenCode Go");
    return route;
  }
  if (route.provider === "openrouter") {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY is required for OpenRouter");
    }
    return route;
  }
  if ((await readOpenAICodexGrant(home)) === undefined) {
    throw new Error(requireOpenAICodexGrantMessage(home));
  }
  return route;
}

function dshCodexCredentialStore(home: string): CredentialStore {
  return {
    async read(providerId) {
      if (providerId !== "openai-codex") return undefined;
      return await readOpenAICodexGrant(home);
    },
    async list() {
      const grant = await readOpenAICodexGrant(home);
      return grant === undefined ? [] : [{ providerId: "openai-codex", type: "oauth" as const }];
    },
    async modify(providerId, fn) {
      if (providerId !== "openai-codex") return undefined;
      const next = await fn(await readOpenAICodexGrant(home));
      if (next === undefined) return undefined;
      const grant = asGrant(next, "OpenAI Codex OAuth");
      await writeOpenAICodexGrant(grant, home);
      return grant;
    },
    async delete(providerId) {
      if (providerId !== "openai-codex") return;
      await deleteOpenAICodexGrant(home);
    },
  };
}

function asGrant(value: Credential | unknown, source: string): OpenAICodexGrant {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${source} did not return an OAuth grant`);
  }
  const candidate = value as Partial<OAuthCredential> & { accountId?: unknown };
  if (candidate.type !== "oauth") {
    throw new Error(`${source} did not return an OAuth grant`);
  }
  if (typeof candidate.access !== "string" || candidate.access.length === 0) {
    throw new Error(`${source} is missing an access token`);
  }
  if (typeof candidate.refresh !== "string" || candidate.refresh.length === 0) {
    throw new Error(`${source} is missing a refresh token`);
  }
  if (typeof candidate.expires !== "number" || !Number.isFinite(candidate.expires)) {
    throw new Error(`${source} is missing a token expiry`);
  }
  if (typeof candidate.accountId !== "string" || candidate.accountId.length === 0) {
    throw new Error(`${source} is missing an account id`);
  }
  return {
    type: "oauth",
    access: candidate.access,
    refresh: candidate.refresh,
    expires: candidate.expires,
    accountId: candidate.accountId,
  };
}

function toJson(value: unknown): unknown {
  if (value !== null && typeof value === "object" && "toJSON" in value) {
    return (value as { toJSON: () => unknown }).toJSON();
  }
  return value;
}

export function formatAuthPrompt(prompt: AuthPrompt): string {
  if (prompt.type !== "select") return `${prompt.message}\n`;
  const lines = [prompt.message];
  for (const [index, option] of prompt.options.entries()) {
    const description = option.description === undefined ? "" : ` — ${option.description}`;
    lines.push(`  ${index + 1}. ${option.label}${description}`);
  }
  return `${lines.join("\n")}\n`;
}

export function answerAuthPrompt(prompt: AuthPrompt, answer: string): string {
  if (prompt.type !== "select") return answer;
  const trimmed = answer.trim();
  const first = prompt.options[0];
  if (trimmed.length === 0) return first?.id ?? trimmed;
  const exact = prompt.options.find((option) => option.id === trimmed);
  if (exact !== undefined) return exact.id;
  const labeled = prompt.options.find(
    (option) => option.label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (labeled !== undefined) return labeled.id;
  const index = Number.parseInt(trimmed, 10);
  if (Number.isInteger(index) && index >= 1 && index <= prompt.options.length) {
    return prompt.options[index - 1]!.id;
  }
  return trimmed;
}

function terminalOAuthInteraction(): { interaction: AuthInteraction; close: () => void } {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  return {
    interaction: {
      async prompt(prompt) {
        if (prompt.signal?.aborted === true) throw abortError();
        return await new Promise<string>((resolve, reject) => {
          const onAbort = () => reject(abortError());
          prompt.signal?.addEventListener("abort", onAbort, { once: true });
          void reader
            .question(formatAuthPrompt(prompt))
            .then((answer) => {
              prompt.signal?.removeEventListener("abort", onAbort);
              resolve(answerAuthPrompt(prompt, answer));
            })
            .catch((error: unknown) => {
              prompt.signal?.removeEventListener("abort", onAbort);
              reject(error);
            });
        });
      },
      notify(event) {
        if (event.type === "auth_url") {
          process.stderr.write(`\nOpen this URL to sign in with ChatGPT:\n${event.url}\n`);
          if (event.instructions !== undefined) process.stderr.write(`${event.instructions}\n`);
          openBrowserUrl(event.url);
          return;
        }
        if (event.type === "device_code") {
          process.stderr.write(
            `\nOpen ${event.verificationUri} and enter code ${event.userCode}\n`,
          );
          return;
        }
        if (event.type === "info" || event.type === "progress") {
          process.stderr.write(`${event.message}\n`);
        }
      },
    },
    close: () => reader.close(),
  };
}

function openBrowserUrl(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const args = process.platform === "win32" ? ["", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => {});
  child.unref();
}

function abortError(): Error {
  const error = new Error("Login cancelled");
  error.name = "AbortError";
  return error;
}

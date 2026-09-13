import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { parse } from "yaml";
import {
  OPENAI_CODEX_CREDENTIAL_KEY,
  answerAuthPrompt,
  assertLlmCredentials,
  deleteOpenAICodexGrant,
  formatAuthPrompt,
  openaiCodexStatus,
  readOpenAICodexGrant,
  writeOpenAICodexGrant,
} from "../openai-codex.js";

test("login method prompts list choices and default to browser", () => {
  const prompt = {
    type: "select" as const,
    message: "Select OpenAI Codex login method:",
    options: [
      { id: "browser", label: "Browser login (default)" },
      { id: "device_code", label: "Device code login (headless)" },
    ],
  };
  assert.match(formatAuthPrompt(prompt), /1\. Browser login \(default\)/);
  assert.match(formatAuthPrompt(prompt), /2\. Device code login \(headless\)/);
  assert.equal(answerAuthPrompt(prompt, ""), "browser");
  assert.equal(answerAuthPrompt(prompt, "2"), "device_code");
  assert.equal(answerAuthPrompt(prompt, "device_code"), "device_code");
});

test("writes an OpenAI Codex grant without dropping other DSH records", async () => {
  const home = await mkdtemp(join(tmpdir(), "mosaik-dsh-"));
  try {
    await writeFile(
      join(home, ".credentials.yaml"),
      "version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: keep-me\n",
      "utf8",
    );
    const path = await writeOpenAICodexGrant(
      {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 1_700_000_000_000,
        accountId: "acct_test",
      },
      home,
    );
    const stored = parse(await readFile(path, "utf8")) as {
      records: Record<string, { payload?: { secret?: string; accountId?: string } }>;
    };
    assert.equal(stored.records["client-connection/browser-session"]?.payload?.secret, "keep-me");
    assert.equal(stored.records[OPENAI_CODEX_CREDENTIAL_KEY]?.payload?.accountId, "acct_test");
    assert.deepEqual(await readOpenAICodexGrant(home), {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_700_000_000_000,
      accountId: "acct_test",
    });
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status is signed in only when the DSH store has a Codex grant", async () => {
  const home = await mkdtemp(join(tmpdir(), "mosaik-dsh-ready-status-"));
  try {
    const path = await writeOpenAICodexGrant(
      {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 1_700_000_000_000,
        accountId: "acct_status",
      },
      home,
    );
    assert.deepEqual(await openaiCodexStatus(home), { signedIn: true, path });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("assertLlmCredentials accepts a stored Codex grant without OpenRouter", async () => {
  const home = await mkdtemp(join(tmpdir(), "mosaik-dsh-ready-"));
  const empty = await mkdtemp(join(tmpdir(), "mosaik-dsh-empty-cred-"));
  const previous = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    await writeOpenAICodexGrant(
      {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 1_700_000_000_000,
        accountId: "acct_ready",
      },
      home,
    );
    await assert.rejects(() => assertLlmCredentials("gpt-5.6-luna", empty), /not signed in/);
    assert.deepEqual(await assertLlmCredentials("gpt-5.6-luna", home), {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
    });
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    await rm(home, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});

test("logout removes the Codex grant and leaves other DSH records", async () => {
  const home = await mkdtemp(join(tmpdir(), "mosaik-dsh-logout-"));
  try {
    await writeFile(
      join(home, ".credentials.yaml"),
      "version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      secret: keep-me\n",
      "utf8",
    );
    await writeOpenAICodexGrant(
      {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 1_700_000_000_000,
        accountId: "acct_logout",
      },
      home,
    );
    const removed = await deleteOpenAICodexGrant(home);
    assert.equal(removed.deleted, true);
    assert.equal(await readOpenAICodexGrant(home), undefined);
    assert.deepEqual(await openaiCodexStatus(home), { signedIn: false, path: removed.path });
    const stored = parse(await readFile(removed.path, "utf8")) as {
      records: Record<string, { payload?: { secret?: string } }>;
    };
    assert.equal(stored.records["client-connection/browser-session"]?.payload?.secret, "keep-me");
    assert.equal(stored.records[OPENAI_CODEX_CREDENTIAL_KEY], undefined);
    assert.deepEqual(await deleteOpenAICodexGrant(home), { path: removed.path, deleted: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status is unsigned when the DSH store has no Codex grant", async () => {
  const home = await mkdtemp(join(tmpdir(), "mosaik-dsh-empty-"));
  try {
    assert.deepEqual(await openaiCodexStatus(home), {
      signedIn: false,
      path: join(home, ".credentials.yaml"),
    });
    assert.deepEqual(await deleteOpenAICodexGrant(home), {
      path: join(home, ".credentials.yaml"),
      deleted: false,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("OpenCode Go requires its own key and accepts it without a Codex login", async () => {
  const previous = process.env.OPENCODE_API_KEY;
  const home = await mkdtemp(join(tmpdir(), "mosaik-go-credentials-"));
  try {
    delete process.env.OPENCODE_API_KEY;
    await assert.rejects(
      () => assertLlmCredentials("opencode-go/deepseek-v4.1-flash", home),
      /OPENCODE_API_KEY is required/,
    );
    process.env.OPENCODE_API_KEY = "test-key";
    for (const model of ["deepseek-v4.1-flash", "gpt-5.6-luna"]) {
      assert.deepEqual(await assertLlmCredentials(`opencode-go/${model}`, home), {
        provider: "opencode-go",
        model,
      });
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previous;
    await rm(home, { recursive: true, force: true });
  }
});

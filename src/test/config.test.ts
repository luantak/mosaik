import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  findKernelAuthConnection,
  loadMosaikConfig,
  loadInteractiveCliHistory,
  rememberInteractiveHistory,
  resolveHumanization,
  saveDefaultBrowser,
  saveHumanizationDefault,
  saveKernelAuthConnection,
  saveInteractiveCliHistory,
  saveOpenRouterKey,
} from "../config.js";

test("interactive history persists URLs and multiline prompts privately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-config-"));
  try {
    assert.deepEqual(await loadInteractiveCliHistory(directory), { urls: [], prompts: [] });
    const path = await saveInteractiveCliHistory(directory, {
      urls: ["https://example.test"],
      prompts: ["find mugs\nand open the cheapest"],
    });
    assert.deepEqual(await loadInteractiveCliHistory(directory), {
      urls: ["https://example.test"],
      prompts: ["find mugs\nand open the cheapest"],
    });
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interactive history moves duplicates to the newest position and caps its size", () => {
  assert.deepEqual(rememberInteractiveHistory(["one", "two"], "one"), ["two", "one"]);
  const values = Array.from({ length: 105 }, (_, index) => `prompt ${index}`);
  const remembered = rememberInteractiveHistory(values, "prompt 105");
  assert.equal(remembered.length, 100);
  assert.equal(remembered[0], "prompt 6");
  assert.equal(remembered.at(-1), "prompt 105");
});

test("provider configuration preserves other env values and replaces the key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-config-"));
  const previous = process.env.OPENROUTER_API_KEY;
  try {
    await writeFile(
      join(directory, ".env"),
      "OTHER=value\n# provider\nexport OPENROUTER_API_KEY=old\n",
      "utf8",
    );
    const path = await saveOpenRouterKey("new-secret", directory);
    assert.equal(path, join(directory, ".env"));
    assert.equal(
      await readFile(path, "utf8"),
      "OTHER=value\n# provider\nOPENROUTER_API_KEY=new-secret\n",
    );
    assert.equal(process.env.OPENROUTER_API_KEY, "new-secret");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider configuration creates a new private env file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-config-"));
  const previous = process.env.OPENROUTER_API_KEY;
  try {
    const path = await saveOpenRouterKey("first-key", directory);
    assert.equal(await readFile(path, "utf8"), "OPENROUTER_API_KEY=first-key\n");
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("project config saves defaults and longest matching Kernel domains atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-config-"));
  const dataDirectory = join(directory, ".mosaik");
  try {
    assert.deepEqual(await loadMosaikConfig(dataDirectory), { version: 1 });
    await saveKernelAuthConnection(dataDirectory, {
      domain: "example.com",
      loginUrl: "https://example.com/login",
      connectionId: "conn_parent",
      profileName: "parent",
    });
    await saveKernelAuthConnection(dataDirectory, {
      domain: "app.example.com",
      loginUrl: "https://app.example.com/login",
      connectionId: "conn_exact",
      profileName: "exact",
    });
    await saveDefaultBrowser(dataDirectory, "kernel");
    const config = await loadMosaikConfig(dataDirectory);
    assert.equal(config.browser, "kernel");
    assert.equal(
      findKernelAuthConnection(config, "https://app.example.com/task")?.connectionId,
      "conn_exact",
    );
    assert.equal(
      findKernelAuthConnection(config, "https://other.example.com/task")?.connectionId,
      "conn_parent",
    );
    assert.equal(findKernelAuthConnection(config, "https://badexample.com/task"), undefined);
    if (process.platform !== "win32") {
      assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(dataDirectory, "config.json"))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project config persists the opt-in humanization default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-config-"));
  const dataDirectory = join(directory, ".mosaik");
  try {
    await saveHumanizationDefault(dataDirectory, true);
    assert.equal((await loadMosaikConfig(dataDirectory)).humanize, true);
    await saveHumanizationDefault(dataDirectory, false);
    assert.equal((await loadMosaikConfig(dataDirectory)).humanize, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit humanization flags override the project default", () => {
  assert.equal(resolveHumanization(undefined, { version: 1 }), false);
  assert.equal(resolveHumanization(undefined, { version: 1, humanize: true }), true);
  assert.equal(resolveHumanization(false, { version: 1, humanize: true }), false);
  assert.equal(resolveHumanization(true, { version: 1, humanize: false }), true);
});

test("malformed project config names its file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-config-"));
  const dataDirectory = join(directory, ".mosaik");
  try {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(join(dataDirectory, "config.json"), '{"version":2}', "utf8");
    await assert.rejects(() => loadMosaikConfig(dataDirectory), /config\.json.*version/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

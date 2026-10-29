import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { DISCOVERY_PROFILE } from "../discovery-profile.js";
import { dshResourcePath, resolveDshCommand } from "../paths.js";

test("DSH source commands use current source plugins without a compiled checkout", async () => {
  assert.match(dshResourcePath("auth-profile.cordis.yml"), /src\/agents\/dsh\/auth-profile/);
  assert.match(dshResourcePath("composition-tools.js"), /src\/agents\/dsh\/composition-tools\.ts$/);
  await access(dshResourcePath("auth-profile.cordis.yml"));
});

test("DSH profiles use PTC tool presentation", async () => {
  const authProfile = await readFile(dshResourcePath("auth-profile.cordis.yml"), "utf8");
  for (const profile of [DISCOVERY_PROFILE, authProfile]) {
    assert.match(profile, /^    mode: ptc$/m);
    assert.doesNotMatch(profile, /^    mode: code$/m);
    assert.match(profile, /^        api: openai-completions$/m);
    assert.match(profile, /^- id: web-fetch-http\n  disabled: true$/m);
  }
});

test("DSH command resolves through the installed dependency", async () => {
  const command = resolveDshCommand();
  assert.equal(command.executable, process.execPath);
  assert.equal(command.prefixArgs.length, 3);
  assert.equal(command.prefixArgs[0], "--import");
  assert.match(command.prefixArgs[2]!, /@deepseek-ai\/dsh\/lib\/bin\.js$/);
  await access(command.prefixArgs[1]!);
  await access(command.prefixArgs[2]!);
  const loaded = spawnSync(
    command.executable,
    [
      ...command.prefixArgs.slice(0, -1),
      "--input-type=module",
      "--eval",
      `const plugin = await import(${JSON.stringify(pathToFileURL(dshResourcePath("composition-tools.js")).href)}); if(typeof plugin.apply !== 'function') throw new Error('Missing plugin entry');`,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(loaded.status, 0, loaded.stderr);
});

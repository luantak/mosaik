import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "vitest";
import { DISCOVERY_PROFILE } from "../discovery-profile.js";
import { dshResourcePath, resolveDshCommand } from "../paths.js";

test("DSH paths separate source profiles from compiled plugins", async () => {
  assert.match(dshResourcePath("auth-profile.cordis.yml"), /src\/agents\/dsh\/auth-profile/);
  assert.match(dshResourcePath("composition-tools.js"), /dist\/agents\/dsh\/composition-tools/);
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
  assert.equal(command.prefixArgs.length, 1);
  assert.match(command.prefixArgs[0]!, /@deepseek-ai\/dsh\/lib\/bin\.js$/);
  await access(command.prefixArgs[0]!);
});

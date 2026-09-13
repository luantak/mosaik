import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadMosaikConfig } from "../../config.js";
import {
  hermesSkillInstallArgs,
  hermesSkillSnapshotMatches,
  hermesSkillUrl,
  installHermesIntegration,
} from "../install.js";

function installOptions(root: string) {
  return {
    dataDirectory: join(root, ".mosaik"),
    packageVersion: "1.2.3",
  };
}

test("pins and verifies the installed skill against the running npm package version", () => {
  const url = "https://cdn.jsdelivr.net/npm/mosaik@1.2.3/integrations/hermes/SKILL.md";
  assert.equal(hermesSkillUrl("1.2.3"), url);
  assert.deepEqual(hermesSkillInstallArgs("1.2.3"), [
    "skills",
    "install",
    url,
    "--force",
    "--yes",
    "--now",
  ]);
  assert.equal(
    hermesSkillSnapshotMatches({ skills: [{ name: "mosaik", identifier: url }] }, url),
    true,
  );
  assert.equal(
    hermesSkillSnapshotMatches(
      { skills: [{ name: "mosaik", identifier: hermesSkillUrl("1.2.2") }] },
      url,
    ),
    false,
  );
  assert.equal(hermesSkillSnapshotMatches({ skills: [] }, url), false);
  assert.equal(hermesSkillSnapshotMatches(null, url), false);
});

test("verifies the release-pinned skill before installing Camoufox and saving state", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-hermes-"));
  const dataDirectory = join(root, ".mosaik");
  const calls: string[] = [];
  try {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(
      join(dataDirectory, "config.json"),
      `${JSON.stringify({ version: 1, model: "openai/gpt-5" }, undefined, 2)}\n`,
    );
    const result = await installHermesIntegration(installOptions(root), {
      installSkill: async (args) => {
        calls.push(`skill:${args.join(" ")}`);
        return 0;
      },
      verifySkill: async (url) => {
        calls.push(`verify:${url}`);
        return true;
      },
      installCamoufox: async () => {
        calls.push("camoufox");
        return 0;
      },
    });

    assert.deepEqual(calls, [
      `skill:${hermesSkillInstallArgs("1.2.3").join(" ")}`,
      `verify:${hermesSkillUrl("1.2.3")}`,
      "camoufox",
    ]);
    assert.deepEqual(result, { skillInstalled: true, camoufoxInstalled: true });
    assert.deepEqual(await loadMosaikConfig(dataDirectory), {
      version: 1,
      browser: "camoufox",
      model: "openai/gpt-5",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not download or modify existing state when skill installation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-hermes-"));
  const dataDirectory = join(root, ".mosaik");
  let camoufoxCalls = 0;
  try {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(
      join(dataDirectory, "config.json"),
      `${JSON.stringify({ version: 1, browser: "local", model: "existing" }, undefined, 2)}\n`,
    );
    const before = await readFile(join(dataDirectory, "config.json"), "utf8");
    const result = await installHermesIntegration(installOptions(root), {
      installSkill: async () => 2,
      verifySkill: async () => true,
      installCamoufox: async () => {
        camoufoxCalls += 1;
        return 0;
      },
    });

    assert.deepEqual(result, { skillInstalled: false, camoufoxInstalled: false });
    assert.equal(camoufoxCalls, 0);
    assert.equal(await readFile(join(dataDirectory, "config.json"), "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not install Camoufox when Hermes did not record the pinned skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-hermes-"));
  let camoufoxCalls = 0;
  try {
    const result = await installHermesIntegration(installOptions(root), {
      installSkill: async () => 0,
      verifySkill: async () => false,
      installCamoufox: async () => {
        camoufoxCalls += 1;
        return 0;
      },
    });

    assert.deepEqual(result, { skillInstalled: false, camoufoxInstalled: false });
    assert.equal(camoufoxCalls, 0);
    assert.equal((await loadMosaikConfig(join(root, ".mosaik"))).browser, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not modify existing state when the Camoufox download fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-hermes-"));
  const dataDirectory = join(root, ".mosaik");
  try {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(
      join(dataDirectory, "config.json"),
      `${JSON.stringify({ version: 1, browser: "local" }, undefined, 2)}\n`,
    );
    const before = await readFile(join(dataDirectory, "config.json"), "utf8");
    const result = await installHermesIntegration(installOptions(root), {
      installSkill: async () => 0,
      verifySkill: async () => true,
      installCamoufox: async () => 1,
    });

    assert.deepEqual(result, { skillInstalled: true, camoufoxInstalled: false });
    assert.equal(await readFile(join(dataDirectory, "config.json"), "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { parseInitCliArgs } from "../cli-options.js";
import { defaultPackageName, initializeMosaikProject, normalizePackageName } from "../init.js";

test("init CLI parses directory, name, and force", () => {
  const parsed = parseInitCliArgs(["./bots/shop", "--name", "Shop Bot", "--force"], "/project");
  assert.equal(parsed.help, false);
  if (parsed.help) return;
  assert.deepEqual(parsed.options, {
    directory: resolve("/project/bots/shop"),
    name: "Shop Bot",
    force: true,
  });
});

test("init CLI defaults the package name from the directory", () => {
  const parsed = parseInitCliArgs(["My Automation"], "/project");
  assert.equal(parsed.help, false);
  if (parsed.help) return;
  assert.equal(parsed.options.name, "my-automation");
});

test("normalizePackageName lowercases and dashes names", () => {
  assert.equal(normalizePackageName("My Bot"), "my-bot");
  assert.equal(defaultPackageName("/tmp/Cool Project"), "cool-project");
});

test("initializeMosaikProject scaffolds a linked TypeScript project", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-init-"));
  const mosaikRoot = join(root, "mosaik");
  const projectRoot = join(root, "project");
  try {
    await mkdir(mosaikRoot, { recursive: true });
    await writeFile(
      join(mosaikRoot, "package.json"),
      `${JSON.stringify({ name: "mosaik", version: "0.1.0" }, null, 2)}\n`,
    );

    const result = await initializeMosaikProject({
      directory: projectRoot,
      name: "demo-bot",
      mosaikPackageRoot: mosaikRoot,
      install: false,
    });

    assert.equal(result.packageName, "demo-bot");
    const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      dependencies: { mosaik: string };
    };
    assert.equal(packageJson.dependencies.mosaik, `link:${mosaikRoot}`);
    assert.match(await readFile(join(projectRoot, "tsconfig.json"), "utf8"), /sites\/\*\*\/\*\.ts/);
    await assert.rejects(() => readFile(join(projectRoot, "automations", ".gitkeep")), /ENOENT/);
    assert.match(await readFile(join(projectRoot, ".gitignore"), "utf8"), /\.mosaik\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeMosaikProject refuses to overwrite without --force", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-init-exists-"));
  const mosaikRoot = join(root, "mosaik");
  const projectRoot = join(root, "project");
  try {
    await mkdir(mosaikRoot, { recursive: true });
    await writeFile(
      join(mosaikRoot, "package.json"),
      `${JSON.stringify({ name: "mosaik", version: "0.1.0" }, null, 2)}\n`,
    );
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "package.json"), "{}\n");
    await assert.rejects(
      () =>
        initializeMosaikProject({
          directory: projectRoot,
          name: "demo-bot",
          mosaikPackageRoot: mosaikRoot,
          install: false,
        }),
      /already exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Consume an already prepared release artifact. This deliberately does not build,
// pack, publish, link a checkout, contact a provider, or download a browser.
const [artifact, ...extra] = process.argv.slice(2);
if (!artifact || extra.length) {
  throw new Error("Usage: node scripts/check-package.mjs /absolute/path/to/mosaik.tgz");
}
const tarball = resolve(artifact);
await access(tarball);
const root = await mkdtemp(join(tmpdir(), "mosaik-package-check-"));
const started = performance.now();
try {
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mosaik-package-check",
      private: true,
      type: "module",
      dependencies: { mosaik: `file:${tarball}`, "@types/node": "24.3.0" },
    }),
  );
  // The package cache must have been populated during release preparation. No
  // source repository is made available to the installed process.
  await run(
    "pnpm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--child-concurrency=1",
      "--network-concurrency=1",
    ],
    root,
  );
  const packageRoot = join(root, "node_modules", "mosaik");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  for (const asset of [
    "dist/cli.js",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/library/actions-api.d.ts",
    "dist/library/automations-api.d.ts",
    "dist/agents/dsh/composition-tools.js",
    "dist/agents/dsh/action-discovery-tools.js",
    "dist/agents/dsh/auth-profile.cordis.yml",
    "dist/kernel/generated-dsh-plugins.js",
  ])
    await access(join(packageRoot, asset));
  const cli = join(packageRoot, "dist/cli.js");
  assert.equal((await run(process.execPath, [cli, "--version"], root)).trim(), manifest.version);
  await run(process.execPath, [cli, "automations", "list", "--json"], root);
  await run(process.execPath, [cli, "init", "./bot", "--no-install"], root);
  const project = JSON.parse(await readFile(join(root, "bot", "package.json"), "utf8"));
  assert.equal(project.dependencies.mosaik, manifest.version);
  assert.ok(!project.dependencies.mosaik.includes("link:"));

  const check = join(root, "check.mjs");
  await writeFile(
    check,
    `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { access } from "node:fs/promises";
import { createMosaik } from "mosaik";
import { defineAction } from "mosaik/actions";
import { defineAutomation } from "mosaik/automations";
assert.equal(typeof createMosaik, "function");
assert.equal(typeof defineAction, "function");
assert.equal(typeof defineAutomation, "function");
const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("mosaik"))));
const { dshResourcePath, resolveDshCommand } = await import(new URL("./agents/dsh/paths.js", import.meta.resolve("mosaik")));
for (const resource of ["composition-tools.js", "action-discovery-tools.js", "auth-profile.cordis.yml"]) {
  const path = dshResourcePath(resource);
  assert.ok(path.startsWith(packageRoot));
  await access(path);
}
await access(resolveDshCommand().prefixArgs[0]);
const require = createRequire(import.meta.resolve("mosaik"));
console.log(join(dirname(require.resolve("typescript/package.json")), "bin", "tsc"));
`,
  );
  const compiler = (await run(process.execPath, [check], root)).trim().split("\n").at(-1);
  assert.ok(compiler);
  await writeFile(
    join(root, "types.ts"),
    `
import { createMosaik, type Mosaik } from "mosaik";
import { defineAutomation } from "mosaik/automations";
const run = defineAutomation(import.meta.url, async (_ctx, input: { category: string }) => input.category);
declare const client: Mosaik;
const output: Promise<string> = run(client, { category: "books" });
void createMosaik; void output;
`,
  );
  await run(
    process.execPath,
    [
      compiler,
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "types.ts",
    ],
    root,
  );
  process.stdout.write(
    `${JSON.stringify({ artifact: tarball, version: manifest.version, status: "passed", durationMs: Math.round(performance.now() - started), modelRequests: 0 })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

function run(executable, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, CI: "true", NODE_OPTIONS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (target, data) => {
      if (stdout.length + stderr.length + data.length > 2_097_152) {
        child.kill("SIGTERM");
        reject(new Error("Package check command exceeded its output limit"));
        return;
      }
      if (target === "stdout") stdout += data;
      else stderr += data;
    };
    child.stdout.on("data", (data) => append("stdout", data.toString()));
    child.stderr.on("data", (data) => append("stderr", data.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Package check command timed out: ${executable}`));
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else
        reject(new Error(`${executable} ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

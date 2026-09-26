import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRuns } from "./verify.mjs";

const exampleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(exampleDirectory, "../..");
const cli = join(packageRoot, "dist/cli.js");
const model = process.argv[2] ?? "opencode-go/gpt-5.6-luna";
const workspace = resolve(
  process.argv[3] ?? join(exampleDirectory, ".runs", new Date().toISOString().replaceAll(":", "-")),
);
const task =
  "Read the first five products on the current catalogue page. Return an array of five objects with title, price, and absolute detail URL in displayed order. Use reusable browser actions and one TypeScript automation; do not click products or write files.";
const url = "https://books.toscrape.com/";

if (process.argv.includes("--help")) {
  console.log("node examples/books-catalogue/run.mjs [model] [new-workspace-directory]");
  process.exit(0);
}
if (!process.env.OPENCODE_API_KEY && model.startsWith("opencode-go/")) {
  throw new Error("Set OPENCODE_API_KEY in your environment. Do not put it in the project.");
}
await mkdir(workspace, { recursive: true });
const run = (args, cwd, outputFile) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (outputFile) return { result, saved: writeFile(join(workspace, outputFile), result.stdout) };
  return { result };
};
const init = run(["init", workspace, "--name", "mosaik-books-demo"], packageRoot);
if (init.result.error || init.result.status !== 0) {
  throw new Error(`mosaik init failed: ${init.result.error ?? init.result.stderr}`);
}
for (const name of ["first", "second"]) {
  console.log(`Running ${name} pass on ${url}...`);
  const { result, saved } = run(
    [
      "run",
      task,
      "--url",
      url,
      "--browser",
      "local",
      "--headless",
      "--model",
      model,
      "--automation-id",
      "booksCatalogueFive",
      "--json",
    ],
    workspace,
    `${name}.json`,
  );
  await saved;
  if (result.error || result.status !== 0) {
    throw new Error(
      `${name} pass failed (exit ${result.status}): ${result.error ?? result.stderr}\nSee ${join(workspace, `${name}.json`)}`,
    );
  }
}
const report = await verifyRuns(join(workspace, "first.json"), join(workspace, "second.json"));
await writeFile(join(workspace, "books.json"), `${JSON.stringify(report.records, null, 2)}\n`);
await writeFile(join(workspace, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ workspace, ...report.summary }, null, 2));
console.log("Inspect sites/books.toscrape.com/actions/ and automations/ in the workspace.");

import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
const main = (args: string[], cwd: string) =>
  execute(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("../cli.ts", import.meta.url)),
      ...args,
    ],
    { cwd },
  );
import { openFileRepository } from "../persist/repository.js";
import { defineAction } from "../capabilities/define.js";

test("reset --force skips the prompt and preserves run output", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-reset-force-"));
  try {
    const repository = openFileRepository({ dataRoot: join(root, ".mosaik"), libraryRoot: root });
    await repository.siteActions.save(
      defineAction({
        id: "example.open",
        name: "openRecord",
        siteId: "example.com",
        description: "Open record",
        inputs: {},
        outputs: {},
        safety: "read-only",
        steps: [{ id: "open", type: "navigate", url: "https://example.com", safety: "read-only" }],
      }),
    );
    await repository.saveAutomation({
      id: "example",
      siteId: "example.com",
      version: 1,
      source: "export default defineAutomation(async () => ({}));",
    });
    const run = join(root, ".mosaik", "runs", "kept");
    await mkdir(run, { recursive: true });
    await writeFile(join(run, "output.json"), "retained");
    await assert.rejects(main(["reset", "--unknown"], root), /Unknown reset option/);
    assert.deepEqual(await repository.inspectLearnedLibrary(), { actions: 1, automations: 1 });
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      await assert.rejects(main(["reset"], root), /interactive terminal/);
    }
    const result = await main(["reset", "--force"], root);
    assert.match(result.stdout, /Cleared 1 learned action and 1 automation/);
    assert.doesNotMatch(result.stdout, /Type exactly|> /);
    assert.deepEqual(await repository.inspectLearnedLibrary(), { actions: 0, automations: 0 });
    assert.equal(await readFile(join(run, "output.json"), "utf8"), "retained");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

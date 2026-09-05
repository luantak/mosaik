import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

test("DSH imports stay limited to adapters and the selected automation runtime", async () => {
  const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
  for (const directory of ["core", "capabilities", "automations", "runtime", "repair", "persist"]) {
    for (const file of await listTs(join(sourceRoot, directory))) {
      const text = await readFile(file, "utf8");
      const isAutomationRuntime = file === join(sourceRoot, "automations", "sandbox.ts");
      assert.equal(text.includes("@deepseek-ai"), isAutomationRuntime, file);
      assert.equal(text.includes("agents/dsh"), false, file);
    }
  }
});

async function listTs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listTs(path);
      return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [path]
        : [];
    }),
  );
  return files.flat();
}

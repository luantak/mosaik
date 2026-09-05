import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { materializeKernelDshAssets, materializeKernelSiteLibrary } from "../dsh-assets.js";

test("Kernel DSH assets materialize as standalone ESM plugins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-kernel-assets-"));
  const previous = process.env.MOSAIK_DSH_RESOURCE_DIR;
  try {
    await materializeKernelDshAssets(directory);
    const composition = await readFile(join(directory, "composition-tools.js"), "utf8");
    const discovery = await readFile(join(directory, "action-discovery-tools.js"), "utf8");
    assert.match(composition, /dsh-composition-semantic-tools/);
    assert.match(discovery, /dsh-action-discovery-semantic-tools/);
    assert.equal(process.env.MOSAIK_DSH_RESOURCE_DIR, directory);
  } finally {
    if (previous === undefined) delete process.env.MOSAIK_DSH_RESOURCE_DIR;
    else process.env.MOSAIK_DSH_RESOURCE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Kernel site-library materialization accepts deployment-specific sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-kernel-custom-library-"));
  try {
    await materializeKernelSiteLibrary(directory, [
      {
        path: "custom.example/actions/readHeading.ts",
        source: "export const custom = true;\n",
      },
    ]);
    assert.equal(
      await readFile(
        join(directory, "sites", "custom.example", "actions", "readHeading.ts"),
        "utf8",
      ),
      "export const custom = true;\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

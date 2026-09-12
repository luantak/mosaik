import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  camoufoxCliPath,
  camoufoxExecutablePath,
  camoufoxFetchCommand,
  camoufoxInstallDirectory,
  inspectCamoufoxInstall,
} from "../install.js";

test("Camoufox install paths follow camoufox-js cache conventions", () => {
  const previous = process.env.CAMOUFOX_INSTALL_DIR;
  try {
    delete process.env.CAMOUFOX_INSTALL_DIR;
    assert.match(camoufoxCliPath(), /camoufox-js[/\\]dist[/\\]__main__\.js$/);
    assert.deepEqual(camoufoxFetchCommand().args.at(-1), "fetch");
    if (process.platform === "linux") {
      assert.match(camoufoxInstallDirectory(), /\.cache\/camoufox$/);
      assert.match(camoufoxExecutablePath(), /camoufox-bin$/);
    }
    process.env.CAMOUFOX_INSTALL_DIR = "/opt/camoufox";
    assert.equal(camoufoxInstallDirectory(), "/opt/camoufox");
    assert.equal(camoufoxExecutablePath(), "/opt/camoufox/camoufox-bin");
  } finally {
    if (previous === undefined) delete process.env.CAMOUFOX_INSTALL_DIR;
    else process.env.CAMOUFOX_INSTALL_DIR = previous;
  }
});

test("inspectCamoufoxInstall reports a missing or present binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-camoufox-"));
  try {
    const missing = await inspectCamoufoxInstall(directory);
    assert.equal(missing.ready, false);
    assert.match(missing.detail, /not found/);
    await mkdir(directory, { recursive: true });
    await writeFile(camoufoxExecutablePath(directory), "#!/bin/sh\n", { mode: 0o755 });
    const ready = await inspectCamoufoxInstall(directory);
    assert.equal(ready.ready, true);
    assert.match(ready.detail, /installed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

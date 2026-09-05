import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectKernelSiteLibrary, deployKernelProject } from "../deploy.js";

test("Kernel deployment packages the caller's canonical site library", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-kernel-deploy-test-"));
  const projectRoot = join(root, "consumer");
  const packageRoot = join(root, "mosaik");
  try {
    await mkdir(join(projectRoot, "sites", "example.com", "actions"), { recursive: true });
    await mkdir(join(projectRoot, "sites", "example.com", "automations"), { recursive: true });
    await mkdir(join(packageRoot, "dist", "kernel"), { recursive: true });
    await writeFile(join(packageRoot, "dist", "kernel", "index.js"), "export {};\n", "utf8");
    await writeFile(join(projectRoot, "package.json"), '{"name":"Mosaik Test"}\n', "utf8");
    await writeFile(join(projectRoot, ".env"), "OPENROUTER_API_KEY=test\n", "utf8");
    await writeFile(
      join(projectRoot, "sites", "example.com", "actions", "readHeading.ts"),
      "export const action = true;\n",
      "utf8",
    );
    await writeFile(
      join(projectRoot, "sites", "example.com", "automations", "read-heading.ts"),
      "export default {};\n",
      "utf8",
    );

    let generatedSource = "";
    const result = await deployKernelProject(
      {
        projectRoot,
        packageRoot,
        version: "mosaik-test",
        envFile: join(projectRoot, ".env"),
        force: true,
      },
      {
        run: async (executable, args, workingDirectory) => {
          assert.equal(executable, "kernel");
          assert.equal(workingDirectory, packageRoot);
          assert.deepEqual(args.slice(0, 2), ["deploy", args[1]]);
          assert.match(args[1]!, /^kernel-app-[0-9a-f-]+\.ts$/);
          assert.deepEqual(args.slice(2), [
            "--version",
            "mosaik-test",
            "--env-file",
            join(projectRoot, ".env"),
            "--env",
            "MOSAIK_LIBRARY_NAMESPACE=mosaik:mosaik-test",
            "--force",
          ]);
          generatedSource = await readFile(join(packageRoot, args[1]!), "utf8");
          return 0;
        },
      },
    );

    assert.deepEqual(result, {
      exitCode: 0,
      filesPackaged: 2,
      namespace: "mosaik:mosaik-test",
    });
    assert.match(generatedSource, /registerKernelMosaikApp/);
    assert.match(generatedSource, /example\.com\/actions\/readHeading\.ts/);
    assert.match(generatedSource, /example\.com\/automations\/read-heading\.ts/);
    assert.deepEqual(await readdir(packageRoot), ["dist"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kernel deployment ignores old root automations and requires canonical sites", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-kernel-library-test-"));
  try {
    await mkdir(join(root, "automations"), { recursive: true });
    await writeFile(join(root, "automations", "legacy.ts"), "export default {};\n", "utf8");
    assert.deepEqual(await collectKernelSiteLibrary(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

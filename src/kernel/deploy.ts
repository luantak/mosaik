import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, sep } from "node:path";
import { defaultLibraryNamespace, readLibraryEnvironment } from "../persist/library-config.js";
import type { KernelSiteLibraryFile } from "./dsh-assets.js";

export interface KernelDeployOptions {
  projectRoot: string;
  packageRoot: string;
  version: string;
  envFile: string;
  namespace?: string;
  force: boolean;
  project?: string;
}

export interface KernelDeployResult {
  exitCode: number;
  filesPackaged: number;
  namespace: string;
}

export interface KernelDeployDependencies {
  run?: (executable: string, args: string[], workingDirectory: string) => Promise<number>;
}

export async function deployKernelProject(
  options: KernelDeployOptions,
  dependencies: KernelDeployDependencies = {},
): Promise<KernelDeployResult> {
  await requireReadableFile(options.envFile, "Kernel environment file");
  const siteLibraryFiles = await collectKernelSiteLibrary(options.projectRoot);
  if (siteLibraryFiles.length === 0) {
    throw new Error(`No actions or automations found under ${join(options.projectRoot, "sites")}`);
  }
  const environment = await readLibraryEnvironment(options.projectRoot, options.envFile);
  const namespace =
    options.namespace ??
    environment.MOSAIK_LIBRARY_NAMESPACE ??
    (await defaultLibraryNamespace(options.projectRoot));
  const runtimeImport = await kernelRuntimeImport(options.packageRoot);
  const entrypoint = join(options.packageRoot, `kernel-app-${randomUUID()}.ts`);
  const relativeEntrypoint = relative(options.packageRoot, entrypoint).split(sep).join("/");
  try {
    await writeFile(entrypoint, renderKernelEntrypoint(siteLibraryFiles, runtimeImport), "utf8");
    const args = [
      "deploy",
      relativeEntrypoint,
      "--version",
      options.version,
      "--env-file",
      options.envFile,
      "--env",
      `MOSAIK_LIBRARY_NAMESPACE=${namespace}`,
      ...(options.force ? ["--force"] : []),
      ...(options.project === undefined ? [] : ["--project", options.project]),
    ];
    const run = dependencies.run ?? spawnAndWait;
    const exitCode = await run("kernel", args, options.packageRoot);
    return { exitCode, filesPackaged: siteLibraryFiles.length, namespace };
  } finally {
    await rm(entrypoint, { force: true });
  }
}

export async function collectKernelSiteLibrary(
  projectRoot: string,
): Promise<KernelSiteLibraryFile[]> {
  const siteRoot = join(projectRoot, "sites");
  const files = await collectTypeScriptFiles(siteRoot);
  return Promise.all(
    files.sort().map(async (path) => {
      const relativePath = relative(siteRoot, path).split(sep).join("/");
      assertCanonicalSiteLibraryPath(relativePath);
      return { path: relativePath, source: await readFile(path, "utf8") };
    }),
  );
}

export function renderKernelEntrypoint(
  files: readonly KernelSiteLibraryFile[],
  runtimeImport = "./dist/kernel/index.js",
): string {
  return `import { registerKernelMosaikApp } from ${JSON.stringify(runtimeImport)};\n\nregisterKernelMosaikApp({ siteLibraryFiles: ${JSON.stringify(files)} });\n`;
}

async function kernelRuntimeImport(packageRoot: string): Promise<string> {
  try {
    await access(join(packageRoot, "dist", "kernel", "index.js"), constants.R_OK);
    return "./dist/kernel/index.js";
  } catch {
    await requireReadableFile(
      join(packageRoot, "src", "kernel", "index.ts"),
      "Mosaik Kernel runtime",
    );
    return "./src/kernel/index.js";
  }
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function assertCanonicalSiteLibraryPath(path: string): void {
  const parts = path.split("/");
  if (
    parts.length < 3 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..") ||
    (parts[1] !== "actions" && parts[1] !== "automations") ||
    !parts.at(-1)?.endsWith(".ts")
  ) {
    throw new Error(`Site library file must use sites/<site>/actions or automations: ${path}`);
  }
}

async function requireReadableFile(path: string, label: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
}

function spawnAndWait(
  executable: string,
  args: string[],
  workingDirectory: string,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: workingDirectory, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

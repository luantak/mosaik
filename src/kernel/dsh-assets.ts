import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  KERNEL_ACTION_DISCOVERY_PLUGIN_SOURCE,
  KERNEL_COMPOSITION_PLUGIN_SOURCE,
  KERNEL_SITE_LIBRARY_FILES,
} from "./generated-dsh-plugins.js";

export interface KernelSiteLibraryFile {
  path: string;
  source: string;
}

export async function materializeKernelDshAssets(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, "composition-tools.js"), KERNEL_COMPOSITION_PLUGIN_SOURCE, "utf8"),
    writeFile(
      join(directory, "action-discovery-tools.js"),
      KERNEL_ACTION_DISCOVERY_PLUGIN_SOURCE,
      "utf8",
    ),
  ]);
  process.env.MOSAIK_DSH_RESOURCE_DIR = directory;
}

export async function materializeKernelSiteLibrary(
  libraryRoot: string,
  files: readonly KernelSiteLibraryFile[] = KERNEL_SITE_LIBRARY_FILES,
): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      const path = safeSiteLibraryPath(libraryRoot, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.source, "utf8");
    }),
  );
}

function safeSiteLibraryPath(libraryRoot: string, relativePath: string): string {
  const parts = relativePath.split("/");
  if (
    parts.length < 3 ||
    parts.some((part) => part.length === 0 || part === "." || part === "..") ||
    (parts[1] !== "actions" && parts[1] !== "automations") ||
    !parts.at(-1)?.endsWith(".ts")
  ) {
    throw new Error(`Invalid embedded site-library path: ${relativePath}`);
  }
  return join(libraryRoot, "sites", ...parts);
}

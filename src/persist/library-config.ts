import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export function resolveLibraryUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return environment.MOSAIK_LIBRARY_URL ?? environment.REDIS_URL;
}

export async function readLibraryEnvironment(
  projectRoot: string,
  envFile = join(projectRoot, ".env"),
): Promise<Record<string, string | undefined>> {
  const fromFile: Record<string, string> = {};
  let source: string;
  try {
    source = await readFile(envFile, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) source = "";
    else throw error;
  }
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fromFile[key] = value;
  }
  return { ...fromFile, ...process.env };
}

export async function defaultLibraryNamespace(projectRoot: string): Promise<string> {
  let name = basename(projectRoot);
  try {
    const packageJson: unknown = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    );
    if (
      packageJson !== null &&
      typeof packageJson === "object" &&
      "name" in packageJson &&
      typeof packageJson.name === "string" &&
      packageJson.name.trim().length > 0
    ) {
      name = packageJson.name;
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  const slug = name
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `mosaik:${slug || "project"}`;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

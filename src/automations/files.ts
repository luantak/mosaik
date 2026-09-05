import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, win32 } from "node:path";
import type { AutomationOutputFile } from "./types.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function writeAutomationOutputFile(
  outputDirectory: string,
  requestedPath: string,
  data: unknown,
): Promise<AutomationOutputFile> {
  const contents = serializeData(data);
  return writeOutput(outputDirectory, requestedPath, Buffer.from(contents, "utf8"));
}

export async function writeAutomationOutputBytes(
  outputDirectory: string,
  requestedPath: string,
  data: Uint8Array,
  options: { onConflict?: "rename" | "error" } = {},
): Promise<AutomationOutputFile> {
  const relativePath = safeRelativePath(requestedPath);
  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? relativePath : suffixedPath(relativePath, index);
    try {
      return await writeOutput(outputDirectory, candidate, data, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (options.onConflict === "error") {
        throw new Error(`Output file already exists: ${relativePath}`);
      }
    }
  }
}

async function writeOutput(
  outputDirectory: string,
  requestedPath: string,
  contents: Uint8Array,
  exclusive = false,
): Promise<AutomationOutputFile> {
  const relativePath = safeRelativePath(requestedPath);
  const root = resolve(outputDirectory);
  const path = resolve(root, relativePath);
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Output path must stay inside this run's output directory");
  }
  const bytes = contents.byteLength;
  if (bytes > MAX_FILE_BYTES) throw new Error("Output file exceeds the 10 MB limit");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, exclusive ? { flag: "wx" } : undefined);
  return { path, relativePath, bytes };
}

function suffixedPath(relativePath: string, index: number): string {
  const directory = posix.dirname(relativePath);
  const filename = posix.basename(relativePath);
  const extension = posix.extname(filename);
  const stem = extension.length === 0 ? filename : filename.slice(0, -extension.length);
  const suffixed = `${stem}-${index}${extension}`;
  return directory === "." ? suffixed : posix.join(directory, suffixed);
}

function safeRelativePath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Output path must be a non-empty relative path");
  }
  if (value.includes("\0") || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error("Output path must be relative to this run's output directory");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === "..")) {
    throw new Error("Output path cannot contain '..'");
  }
  return normalized.replace(/^\.\//, "");
}

function serializeData(data: unknown): string {
  if (typeof data === "string") return data;
  const serialized = JSON.stringify(data, null, 2);
  if (serialized === undefined) throw new Error("Output data must be a string or JSON value");
  return `${serialized}\n`;
}

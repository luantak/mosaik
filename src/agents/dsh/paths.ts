import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const runningFromSource = basename(resolve(moduleDirectory, "../..")) === "src";

export interface DshCommand {
  executable: string;
  prefixArgs: string[];
}

export function dshResourcePath(filename: string): string {
  const resourceDirectory = process.env.MOSAIK_DSH_RESOURCE_DIR;
  if (resourceDirectory !== undefined && resourceDirectory.length > 0) {
    return resolve(resourceDirectory, filename);
  }
  if (runningFromSource && filename.endsWith(".js")) {
    return resolve(moduleDirectory, "../../../dist/agents/dsh", filename);
  }
  return resolve(moduleDirectory, filename);
}

export function resolveDshCommand(): DshCommand {
  const packageRoot = dirname(require.resolve("@deepseek-ai/dsh/package.json"));
  return {
    executable: process.execPath,
    prefixArgs: [resolve(packageRoot, "lib/bin.js")],
  };
}

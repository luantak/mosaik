import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { SiteActionDefinition } from "../capabilities/types.js";

export function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => [key, canonical(v)]),
      );
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Usage counters and verification promotion do not change executable behavior. */
export function actionFingerprint(action: SiteActionDefinition): string {
  return fingerprint({
    id: action.id,
    siteId: action.siteId,
    name: action.name,
    version: action.version,
    interfaceVersion: action.interfaceVersion,
    contractVersion: action.contractVersion,
    inputs: action.inputs,
    outputs: action.outputs,
    safety: action.safety,
    implementation: action.implementation,
    implementations: action.implementations,
  });
}

export async function runtimeFingerprint(): Promise<string> {
  const require = createRequire(import.meta.url);
  const versions: Record<string, unknown> = {
    node: process.versions.node.split(".")[0],
    protocol: 1,
  };
  for (const name of ["playwright", "@deepseek-ai/dsh-code-runtime-worker-thread"])
    versions[name] = JSON.parse(
      await readFile(require.resolve(`${name}/package.json`), "utf8"),
    ).version;
  for (const path of [
    "../automations/sandbox",
    "../automations/run",
    "../automations/host",
    "../automations/acceptance",
    "../runtime/execute",
    "./store",
    "./prepare",
    "./runtime",
    "./worker",
  ]) {
    let contents: string;
    try {
      contents = await readFile(new URL(`${path}.js`, import.meta.url), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      contents = await readFile(new URL(`${path}.ts`, import.meta.url), "utf8");
    }
    versions[path] = fingerprint(contents);
  }
  return fingerprint(versions);
}

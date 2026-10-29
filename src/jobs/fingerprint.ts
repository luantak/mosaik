import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
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
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  versions.package = { version: manifest.version, dependencies: manifest.dependencies };
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  // Include runtime transitive modules too: locator/schema/policy edits must not
  // masquerade as an unchanged executor merely because run.ts itself stayed put.
  for (const directory of [
    "automations",
    "capabilities",
    "core",
    "evidence",
    "jobs",
    "library",
    "persist",
    "repair",
    "runtime",
  ])
    await collect(new URL(`../${directory}/`, import.meta.url), directory);
  async function collect(directory: URL, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "test" || entry.name === "__tests__") continue;
      if (entry.isDirectory())
        await collect(new URL(`${entry.name}/`, directory), `${prefix}/${entry.name}`);
      else if (
        entry.isFile() &&
        entry.name.endsWith(extension) &&
        !entry.name.endsWith(".d.ts") &&
        !entry.name.endsWith(".test.ts")
      )
        versions[`${prefix}/${entry.name}`] = fingerprint(
          await readFile(new URL(entry.name, directory), "utf8"),
        );
    }
  }
  return fingerprint(versions);
}

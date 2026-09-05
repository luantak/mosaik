import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
export const generatedKernelAssetsPath = resolve(root, "src/kernel/generated-dsh-plugins.ts");
const plugins = [
  ["KERNEL_COMPOSITION_PLUGIN_SOURCE", "src/agents/dsh/composition-tools.ts"],
  ["KERNEL_ACTION_DISCOVERY_PLUGIN_SOURCE", "src/agents/dsh/action-discovery-tools.ts"],
];

export async function buildKernelAssets(options = {}) {
  const exports = [];
  for (const [name, entryPoint] of plugins) {
    const result = await build({
      entryPoints: [resolve(root, entryPoint)],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      packages: "external",
      write: false,
      sourcemap: false,
      logLevel: "warning",
    });
    const output = result.outputFiles[0];
    if (output === undefined) throw new Error(`esbuild produced no output for ${entryPoint}`);
    exports.push(`export const ${name} = ${JSON.stringify(output.text)};`);
  }

  const siteRoot = resolve(root, "sites");
  const siteFiles = await collectFiles(siteRoot);
  const siteLibrary = await Promise.all(
    siteFiles
      .filter((path) => path.endsWith(".ts"))
      .sort()
      .map(async (path) => ({
        path: relative(siteRoot, path).split(sep).join("/"),
        source: await readFile(path, "utf8"),
      })),
  );
  exports.push(`export const KERNEL_SITE_LIBRARY_FILES = ${JSON.stringify(siteLibrary)} as const;`);
  const source = `// Generated during build. Do not edit by hand.\n${exports.join("\n")}\n`;
  if (options.write !== false) await writeFile(generatedKernelAssetsPath, source, "utf8");
  return source;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildKernelAssets({ write: !process.argv.includes("--check") });
}

async function collectFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

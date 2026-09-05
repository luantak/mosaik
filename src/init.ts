import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface InitProjectOptions {
  directory: string;
  name: string;
  mosaikPackageRoot: string;
  force?: boolean;
  install?: boolean;
}

export interface InitProjectResult {
  directory: string;
  packageName: string;
  mosaikPath: string;
  created: string[];
}

export async function initializeMosaikProject(
  options: InitProjectOptions,
): Promise<InitProjectResult> {
  const directory = resolve(options.directory);
  const packageName = normalizePackageName(options.name);
  const mosaikPath = resolve(options.mosaikPackageRoot);
  const force = options.force === true;
  const shouldInstall = options.install !== false;

  await assertMosaikPackage(mosaikPath);
  await mkdir(directory, { recursive: true });

  const files: Array<{ relativePath: string; contents: string }> = [
    {
      relativePath: "package.json",
      contents: `${JSON.stringify(
        {
          name: packageName,
          private: true,
          type: "module",
          scripts: {
            check: "tsc --noEmit",
          },
          dependencies: {
            mosaik: `link:${mosaikPath}`,
          },
          devDependencies: {
            "@types/node": "24.3.0",
            typescript: "7.0.2",
          },
          packageManager: "pnpm@11.7.0",
        },
        null,
        2,
      )}\n`,
    },
    {
      relativePath: "tsconfig.json",
      contents: `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: true,
            noEmit: true,
            skipLibCheck: true,
            types: ["node"],
          },
          include: ["sites/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    },
    {
      relativePath: ".gitignore",
      contents: ["node_modules/", ".mosaik/", ".env", "dist/", "*.tsbuildinfo", ""].join("\n"),
    },
    {
      relativePath: "sites/.gitkeep",
      contents: "",
    },
  ];

  const created: string[] = [];
  for (const file of files) {
    const path = resolve(directory, file.relativePath);
    if (!force && (await exists(path))) {
      throw new Error(
        `${file.relativePath} already exists in ${directory}. Pass --force to overwrite.`,
      );
    }
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, file.contents, "utf8");
    created.push(file.relativePath);
  }

  if (shouldInstall) {
    const code = await runPnpm(["install"], directory);
    if (code !== 0) {
      throw new Error(`pnpm install failed with exit code ${code}`);
    }
  }

  return { directory, packageName, mosaikPath, created };
}

export function normalizePackageName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("Package name is required");
  const name = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._~/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (name.length === 0) throw new Error(`Invalid package name: ${value}`);
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) {
    throw new Error(`Invalid package name: ${value}`);
  }
  return name;
}

export function defaultPackageName(directory: string): string {
  const base = basename(resolve(directory));
  if (base.length === 0 || base === "." || base === "/" || base === "\\") {
    return "mosaik-project";
  }
  try {
    return normalizePackageName(base);
  } catch {
    return "mosaik-project";
  }
}

async function assertMosaikPackage(path: string): Promise<void> {
  const packageJsonPath = resolve(path, "package.json");
  if (!(await exists(packageJsonPath))) {
    throw new Error(`Mosaik package not found at ${path}`);
  }
  const raw: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("name" in raw) ||
    (raw as { name?: unknown }).name !== "mosaik"
  ) {
    throw new Error(`Expected a mosaik package.json at ${packageJsonPath}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runPnpm(args: string[], cwd: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("pnpm", args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
}

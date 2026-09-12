import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

export interface CamoufoxInstallStatus {
  ready: boolean;
  installDirectory: string;
  executablePath: string;
  detail: string;
}

export function camoufoxPackageRoot(): string {
  return dirname(require.resolve("camoufox-js/package.json"));
}

export function camoufoxCliPath(): string {
  return resolve(camoufoxPackageRoot(), "dist/__main__.js");
}

export function camoufoxFetchCommand(): { executable: string; args: string[] } {
  return { executable: process.execPath, args: [camoufoxCliPath(), "fetch"] };
}

export function camoufoxInstallDirectory(): string {
  if (
    process.env.CAMOUFOX_INSTALL_DIR !== undefined &&
    process.env.CAMOUFOX_INSTALL_DIR.length > 0
  ) {
    return resolve(process.env.CAMOUFOX_INSTALL_DIR);
  }
  if (process.platform === "darwin") return resolve(homedir(), "Library/Caches/camoufox");
  if (process.platform === "win32") {
    return resolve(homedir(), "AppData", "Local", "camoufox", "camoufox", "Cache");
  }
  return resolve(homedir(), ".cache/camoufox");
}

export function camoufoxExecutablePath(installDirectory = camoufoxInstallDirectory()): string {
  if (process.platform === "win32") return resolve(installDirectory, "camoufox.exe");
  if (process.platform === "darwin") {
    return resolve(installDirectory, "Camoufox.app", "Contents", "MacOS", "camoufox");
  }
  return resolve(installDirectory, "camoufox-bin");
}

export async function inspectCamoufoxInstall(
  installDirectory = camoufoxInstallDirectory(),
): Promise<CamoufoxInstallStatus> {
  const executablePath = camoufoxExecutablePath(installDirectory);
  try {
    await access(executablePath, constants.R_OK);
    return {
      ready: true,
      installDirectory,
      executablePath,
      detail: `${basename(executablePath)} installed`,
    };
  } catch {
    return {
      ready: false,
      installDirectory,
      executablePath,
      detail: "browser binary not found",
    };
  }
}

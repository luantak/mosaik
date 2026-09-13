import type { SetupBrowser } from "./cli-options.js";
import type { BrowserProvider } from "./config.js";

type BrowserBinaryStatus = "pass" | "warn" | "fail";

export function browserBinaryStatuses(
  selected: BrowserProvider,
  chromiumReady: boolean,
  camoufoxReady: boolean,
): { chromium: BrowserBinaryStatus; camoufox: BrowserBinaryStatus } {
  return {
    chromium: chromiumReady ? "pass" : selected === "local" ? "fail" : "warn",
    camoufox: camoufoxReady ? "pass" : selected === "camoufox" ? "fail" : "warn",
  };
}

export interface BrowserBinaryInstallers {
  installChromium(): Promise<number>;
  installCamoufox(): Promise<number>;
}

export interface BrowserBinaryInstallResult {
  chromium?: boolean;
  camoufox?: boolean;
}

export async function installBrowserBinaries(
  browser: SetupBrowser,
  installers: BrowserBinaryInstallers,
): Promise<BrowserBinaryInstallResult> {
  const result: BrowserBinaryInstallResult = {};
  if (browser === "chromium" || browser === "all") {
    result.chromium = (await installers.installChromium()) === 0;
  }
  if (browser === "camoufox" || browser === "all") {
    result.camoufox = (await installers.installCamoufox()) === 0;
  }
  return result;
}

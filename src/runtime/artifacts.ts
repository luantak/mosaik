import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { collectOverview } from "./overview.js";

export interface CapturedArtifacts {
  screenshot?: string;
  accessibilitySnapshot?: string;
  consoleLogs: string[];
  networkErrors: string[];
  overviewText: string;
  similarNames: string[];
}

export function attachPageCollectors(page: Page): {
  consoleLogs: string[];
  networkErrors: string[];
} {
  const consoleLogs: string[] = [];
  const networkErrors: string[] = [];
  page.on("console", (message) => {
    consoleLogs.push(`${message.type()}: ${message.text()}`);
  });
  page.on("requestfailed", (request) => {
    networkErrors.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`);
  });
  return { consoleLogs, networkErrors };
}

export async function captureFailureArtifacts(
  page: Page,
  directory: string,
  collectors: { consoleLogs: string[]; networkErrors: string[] },
): Promise<CapturedArtifacts> {
  await mkdir(directory, { recursive: true });
  const overview = await collectOverview(page);
  const screenshotPath = join(directory, "failure.png");
  const overviewPath = join(directory, "overview.txt");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await writeFile(overviewPath, overview.text, "utf8");
  return {
    screenshot: screenshotPath,
    accessibilitySnapshot: overviewPath,
    consoleLogs: [...collectors.consoleLogs],
    networkErrors: [...collectors.networkErrors],
    overviewText: overview.text,
    similarNames: overview.interactive
      .map((item) => item.name)
      .filter((name): name is string => name !== undefined),
  };
}

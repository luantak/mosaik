import { chromium, type Browser } from "playwright";
import { PAGE_SIGNAL_INIT } from "./degraded.js";

export async function withBrowser<T>(run: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    return await run(browser);
  } finally {
    await browser.close();
  }
}

export async function withIsolatedContext<T>(
  browser: Browser,
  run: (page: import("playwright").Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext();
  await context.addInitScript(PAGE_SIGNAL_INIT);
  try {
    const page = await context.newPage();
    return await run(page);
  } finally {
    await context.close();
  }
}

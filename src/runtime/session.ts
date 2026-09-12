import { createServer } from "node:net";
import { join } from "node:path";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { CamoufoxOptions } from "../camoufox/options.js";
import { BrowserResponseCache, type CapturedBrowserResponse } from "./assets.js";
import { PAGE_SIGNAL_INIT } from "./degraded.js";
import { configurePageHumanization } from "./humanize.js";

export interface BrowserSession {
  kind: "ephemeral" | "persistent";
  provider?: "local" | "kernel" | "camoufox";
  camoufox?: CamoufoxOptions;
  profileDirectory?: string;
  cdpEndpoint?: string;
  cdpTargetId?: string;
  defaultStepTimeoutMs?: number;
  withPage<T>(run: (page: Page) => Promise<T>): Promise<T>;
  readCapturedResponse?(
    url: string,
    options?: { reuseOnly?: boolean },
  ): Promise<CapturedBrowserResponse>;
  close(): Promise<void>;
}

export interface InteractiveBrowserSession extends BrowserSession {
  kind: "persistent";
  profileDirectory: string;
  currentUrl(): string;
  readCapturedResponse(
    url: string,
    options?: { reuseOnly?: boolean },
  ): Promise<CapturedBrowserResponse>;
}

export interface BrowserSessionOptions {
  profileDirectory?: string;
  headless?: boolean;
  /** Humanize runtime input delivery without changing generated steps or saved source. */
  humanize?: boolean;
  browser?: "local" | "camoufox";
  camoufox?: CamoufoxOptions;
}

export const MOSAIK_CDP_WS_URL_ENV = "MOSAIK_CDP_WS_URL";
export const MOSAIK_BROWSER_ENV = "MOSAIK_BROWSER";
export const MOSAIK_CAMOUFOX_OPTIONS_ENV = "MOSAIK_CAMOUFOX_OPTIONS";
export const DEFAULT_REMOTE_STEP_TIMEOUT_MS = 5_000;
const safelyHandledDialogPages = new WeakSet<Page>();

export async function openBrowserSession(
  options: BrowserSessionOptions = {},
): Promise<BrowserSession> {
  if (options.browser === "camoufox") {
    const { openCamoufoxBrowserSession } = await import("../camoufox/session.js");
    return openCamoufoxBrowserSession(options);
  }
  if (options.profileDirectory !== undefined) {
    return openInteractiveBrowserSession({
      startUrl: "about:blank",
      profileDirectory: options.profileDirectory,
      headless: options.headless ?? true,
      ...(options.humanize === undefined ? {} : { humanize: options.humanize }),
    });
  }
  const launched = await launchCdpBrowser(options.headless ?? true);
  return ephemeralSession(launched.browser, {
    cdpEndpoint: launched.cdpEndpoint,
    close: () => launched.browser.close(),
    ...(options.humanize === undefined ? {} : { humanize: options.humanize }),
  });
}

export async function openInteractiveBrowserSession(options: {
  startUrl: string;
  profileDirectory: string;
  headless?: boolean;
  humanize?: boolean;
  browser?: "local" | "camoufox";
  camoufox?: CamoufoxOptions;
}): Promise<InteractiveBrowserSession> {
  if (options.browser === "camoufox") {
    const { openCamoufoxInteractiveBrowserSession } = await import("../camoufox/session.js");
    return openCamoufoxInteractiveBrowserSession(options);
  }
  await prepareProfileDirectory(options.profileDirectory);
  const context = await chromium.launchPersistentContext(options.profileDirectory, {
    headless: options.headless ?? false,
    args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
  });
  await context.addInitScript(PAGE_SIGNAL_INIT);
  const initialPage = await adoptSinglePage(context, options.startUrl);
  await configurePageHumanization(initialPage, options.humanize ?? false);
  installSafeDialogHandler(initialPage);
  const [port] = (await readFile(join(options.profileDirectory, "DevToolsActivePort"), "utf8"))
    .trim()
    .split("\n");
  const cdpEndpoint = `http://127.0.0.1:${port}`;
  let page: Page = initialPage;
  let responses = new BrowserResponseCache(
    page,
    /^https?:/.test(options.startUrl) ? { networkOrigin: new URL(options.startUrl).origin } : {},
  );
  try {
    await page.goto(options.startUrl, { waitUntil: "domcontentloaded" });
  } catch (error) {
    await context.close();
    throw error;
  }
  let closed = false;

  const activePage = async (): Promise<Page> => {
    if (!page.isClosed()) return page;
    responses.close();
    page = context.pages().find((candidate) => !candidate.isClosed()) ?? (await context.newPage());
    await configurePageHumanization(page, options.humanize ?? false);
    installSafeDialogHandler(page);
    responses = new BrowserResponseCache(
      page,
      /^https?:/.test(options.startUrl) ? { networkOrigin: new URL(options.startUrl).origin } : {},
    );
    if (page.url() === "about:blank") {
      await page.goto(options.startUrl, { waitUntil: "domcontentloaded" });
    }
    return page;
  };

  return {
    kind: "persistent",
    profileDirectory: options.profileDirectory,
    cdpEndpoint,
    async withPage<T>(run: (active: Page) => Promise<T>): Promise<T> {
      return run(await activePage());
    },
    readCapturedResponse: (url, readOptions) => responses.read(url, readOptions),
    currentUrl: () => (page.isClosed() ? options.startUrl : page.url()),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      responses.close();
      await context.close();
    },
  };
}

export function isBrowserSession(value: Browser | BrowserSession): value is BrowserSession {
  return "kind" in value && "withPage" in value;
}

export async function openAgentBrowser(): Promise<Browser> {
  if (process.env[MOSAIK_BROWSER_ENV] === "camoufox") {
    const { openCamoufoxAgentBrowser } = await import("../camoufox/session.js");
    return openCamoufoxAgentBrowser();
  }
  const endpoint = process.env[MOSAIK_CDP_WS_URL_ENV];
  return endpoint === undefined || endpoint.length === 0
    ? chromium.launch({ headless: true })
    : chromium.connectOverCDP(endpoint);
}

export async function connectBrowserSessionOverCdp(cdpEndpoint: string): Promise<BrowserSession> {
  if (cdpEndpoint.trim().length === 0) throw new Error("CDP endpoint is required");
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  return ephemeralSession(browser, { cdpEndpoint });
}

export function browserSessionEnvironment(session: Browser | BrowserSession): NodeJS.ProcessEnv {
  if (isBrowserSession(session) && session.provider === "camoufox") {
    return {
      [MOSAIK_BROWSER_ENV]: "camoufox",
      [MOSAIK_CAMOUFOX_OPTIONS_ENV]: JSON.stringify(session.camoufox ?? {}),
    };
  }
  return isBrowserSession(session) && session.cdpEndpoint !== undefined
    ? {
        [MOSAIK_CDP_WS_URL_ENV]: session.cdpEndpoint,
        ...(session.cdpTargetId ? { MOSAIK_CDP_TARGET_ID: session.cdpTargetId } : {}),
      }
    : {};
}

export function ephemeralSession(
  browser: Browser,
  options: {
    cdpEndpoint?: string;
    close?: () => Promise<void>;
    defaultStepTimeoutMs?: number;
    humanize?: boolean;
  } = {},
): BrowserSession {
  const defaultStepTimeoutMs =
    options.defaultStepTimeoutMs ??
    (options.cdpEndpoint === undefined ? undefined : DEFAULT_REMOTE_STEP_TIMEOUT_MS);
  return {
    kind: "ephemeral",
    ...(options.cdpEndpoint === undefined ? {} : { cdpEndpoint: options.cdpEndpoint }),
    ...(defaultStepTimeoutMs === undefined ? {} : { defaultStepTimeoutMs }),
    async withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
      const context = await browser.newContext();
      await context.addInitScript(PAGE_SIGNAL_INIT);
      try {
        const page = await context.newPage();
        await configurePageHumanization(page, options.humanize ?? false);
        installSafeDialogHandler(page);
        return await run(page);
      } finally {
        await context.close();
      }
    },
    close: options.close ?? (() => browser.close()),
  };
}

/** Reuse the browser's profile-backed context and active page for the session lifetime. */
export async function sharedContextSession(
  browser: Browser,
  options: {
    cdpEndpoint?: string;
    close?: () => Promise<void>;
    defaultStepTimeoutMs?: number;
    humanize?: boolean;
  } = {},
): Promise<BrowserSession> {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  await context.addInitScript(PAGE_SIGNAL_INIT);
  let page =
    context.pages().find((candidate) => !candidate.isClosed()) ?? (await context.newPage());
  await configurePageHumanization(page, options.humanize ?? false);
  installSafeDialogHandler(page);
  const defaultStepTimeoutMs =
    options.defaultStepTimeoutMs ??
    (options.cdpEndpoint === undefined ? undefined : DEFAULT_REMOTE_STEP_TIMEOUT_MS);

  const activePage = async (): Promise<Page> => {
    if (!page.isClosed()) return page;
    page = context.pages().find((candidate) => !candidate.isClosed()) ?? (await context.newPage());
    await configurePageHumanization(page, options.humanize ?? false);
    installSafeDialogHandler(page);
    return page;
  };

  return {
    kind: "ephemeral",
    ...(options.cdpEndpoint === undefined ? {} : { cdpEndpoint: options.cdpEndpoint }),
    ...(defaultStepTimeoutMs === undefined ? {} : { defaultStepTimeoutMs }),
    async withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
      return run(await activePage());
    },
    close: options.close ?? (() => browser.close()),
  };
}

async function prepareProfileDirectory(profileDirectory: string): Promise<void> {
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(profileDirectory, 0o700);
}

async function launchCdpBrowser(
  headless: boolean,
): Promise<{ browser: Browser; cdpEndpoint: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await reserveLoopbackPort();
    try {
      const browser = await chromium.launch({
        executablePath: chromium.executablePath(),
        headless,
        args: [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
      });
      return { browser, cdpEndpoint: `http://127.0.0.1:${port}` };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to launch Chromium");
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  server.unref();
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local debugging port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error === undefined ? resolve(port) : reject(error)));
    });
  });
}

async function adoptSinglePage(context: BrowserContext, startUrl: string): Promise<Page> {
  const existing = context.pages().filter((page) => !page.isClosed());
  const page =
    existing.find((candidate) => samePageUrl(candidate.url(), startUrl)) ??
    existing.find((candidate) => candidate.url() === "about:blank") ??
    existing[0] ??
    (await context.newPage());
  await Promise.all(
    existing
      .filter((candidate) => candidate !== page && !candidate.isClosed())
      .map((extra) => extra.close()),
  );
  return page;
}

function samePageUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

/** Attach only the invocation-owned target. Never select another user's tab. */
export async function sharedAgentPage(browser: Browser): Promise<Page | undefined> {
  const targetId = process.env.MOSAIK_CDP_TARGET_ID;
  if (!targetId) return undefined;
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if ((await pageTargetId(page)) === targetId) {
        installSafeDialogHandler(page);
        return page;
      }
    }
  }
  throw new Error("The invocation browser page is no longer available");
}

function installSafeDialogHandler(page: Page): void {
  if (safelyHandledDialogPages.has(page)) return;
  safelyHandledDialogPages.add(page);
  page.on("dialog", (dialog) => {
    // Multiple Playwright connections receive the same CDP dialog event. They
    // may race, so the losing connection must tolerate "No dialog is showing".
    const handled = dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss();
    void handled.catch(() => undefined);
  });
}

export async function pageTargetId(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    return (await session.send("Target.getTargetInfo")).targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

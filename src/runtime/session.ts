import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmod, mkdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserResponseCache, type CapturedBrowserResponse } from "./assets.js";
import { PAGE_SIGNAL_INIT } from "./degraded.js";
import { configurePageHumanization } from "./humanize.js";

export interface BrowserSession {
  kind: "ephemeral" | "persistent";
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
}

export const MOSAIK_CDP_WS_URL_ENV = "MOSAIK_CDP_WS_URL";
export const DEFAULT_REMOTE_STEP_TIMEOUT_MS = 5_000;
const safelyHandledDialogPages = new WeakSet<Page>();

export async function openBrowserSession(
  options: BrowserSessionOptions = {},
): Promise<BrowserSession> {
  if (options.profileDirectory === undefined) {
    const profileDirectory = await mkdtemp(join(tmpdir(), "mosaik-browser-"));
    try {
      const session = await openInteractiveBrowserSession({
        startUrl: "about:blank",
        profileDirectory,
        headless: options.headless ?? true,
        ...(options.humanize === undefined ? {} : { humanize: options.humanize }),
      });
      try {
        const browser = await chromium.connectOverCDP(session.cdpEndpoint!);
        return ephemeralSession(browser, {
          cdpEndpoint: session.cdpEndpoint!,
          ...(options.humanize === undefined ? {} : { humanize: options.humanize }),
          close: async () => {
            try {
              await browser.close();
            } finally {
              try {
                await session.close();
              } finally {
                await rm(profileDirectory, { recursive: true, force: true });
              }
            }
          },
        });
      } catch (error) {
        await session.close();
        throw error;
      }
    } catch (error) {
      await rm(profileDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  return openInteractiveBrowserSession({
    startUrl: "about:blank",
    profileDirectory: options.profileDirectory,
    headless: options.headless ?? true,
    ...(options.humanize === undefined ? {} : { humanize: options.humanize }),
  });
}

export async function openInteractiveBrowserSession(options: {
  startUrl: string;
  profileDirectory: string;
  headless?: boolean;
  humanize?: boolean;
}): Promise<InteractiveBrowserSession> {
  await prepareProfileDirectory(options.profileDirectory);
  const context = await chromium.launchPersistentContext(options.profileDirectory, {
    headless: options.headless ?? false,
    args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
  });
  await context.addInitScript(PAGE_SIGNAL_INIT);
  const initialPage =
    context.pages().find((candidate) => candidate.url() === "about:blank") ??
    context.pages().find((candidate) => !candidate.isClosed()) ??
    (await context.newPage());
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

import { chmod, mkdir } from "node:fs/promises";
import { Camoufox } from "camoufox-js";
import type { Browser, BrowserContext, Page } from "playwright";
import { BrowserResponseCache } from "../runtime/assets.js";
import { PAGE_SIGNAL_INIT } from "../runtime/degraded.js";
import { configurePageHumanization } from "../runtime/humanize.js";
import {
  MOSAIK_CAMOUFOX_OPTIONS_ENV,
  ephemeralSession,
  type BrowserSession,
  type InteractiveBrowserSession,
} from "../runtime/session.js";
import { toCamoufoxLaunchOptions, type CamoufoxOptions } from "./options.js";

export interface CamoufoxBrowserSession extends BrowserSession {
  readonly provider: "camoufox";
  readonly camoufox: CamoufoxOptions;
}

export interface CamoufoxInteractiveBrowserSession extends InteractiveBrowserSession {
  readonly provider: "camoufox";
  readonly camoufox: CamoufoxOptions;
}

export interface CamoufoxBrowserSessionOptions {
  profileDirectory?: string;
  startUrl?: string;
  headless?: boolean;
  humanize?: boolean;
  camoufox?: CamoufoxOptions;
}

export async function openCamoufoxBrowserSession(
  options: CamoufoxBrowserSessionOptions = {},
): Promise<CamoufoxBrowserSession | CamoufoxInteractiveBrowserSession> {
  if (options.profileDirectory !== undefined) {
    return openCamoufoxInteractiveBrowserSession({
      startUrl: options.startUrl ?? "about:blank",
      profileDirectory: options.profileDirectory,
      headless: options.headless ?? true,
      ...(options.humanize === undefined ? {} : { humanize: options.humanize }),
      ...(options.camoufox === undefined ? {} : { camoufox: options.camoufox }),
    });
  }
  const camoufox = options.camoufox ?? {};
  const launch = toCamoufoxLaunchOptions(camoufox, { headless: options.headless ?? true });
  const browser = (await Camoufox(launch)) as Browser;
  const session = ephemeralSession(
    browser,
    options.humanize === undefined ? {} : { humanize: options.humanize },
  );
  return {
    ...session,
    provider: "camoufox",
    camoufox,
  };
}

export async function openCamoufoxInteractiveBrowserSession(options: {
  startUrl: string;
  profileDirectory: string;
  headless?: boolean;
  humanize?: boolean;
  camoufox?: CamoufoxOptions;
}): Promise<CamoufoxInteractiveBrowserSession> {
  await prepareProfileDirectory(options.profileDirectory);
  const camoufox = options.camoufox ?? {};
  const launch = toCamoufoxLaunchOptions(camoufox, {
    headless: options.headless ?? false,
    userDataDir: options.profileDirectory,
  });
  const context = (await Camoufox(launch)) as BrowserContext;
  await context.addInitScript(PAGE_SIGNAL_INIT);
  const initialPage =
    context.pages().find((candidate) => candidate.url() === "about:blank") ??
    context.pages().find((candidate) => !candidate.isClosed()) ??
    (await context.newPage());
  await configurePageHumanization(initialPage, options.humanize ?? false);
  installSafeDialogHandler(initialPage);
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
    provider: "camoufox",
    camoufox,
    profileDirectory: options.profileDirectory,
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

export async function openCamoufoxAgentBrowser(): Promise<Browser> {
  const source = process.env[MOSAIK_CAMOUFOX_OPTIONS_ENV];
  const camoufox =
    source === undefined || source.length === 0 ? {} : (JSON.parse(source) as CamoufoxOptions);
  const launch = toCamoufoxLaunchOptions(camoufox, { headless: true });
  return (await Camoufox(launch)) as Browser;
}

const safelyHandledDialogPages = new WeakSet<Page>();

function installSafeDialogHandler(page: Page): void {
  if (safelyHandledDialogPages.has(page)) return;
  safelyHandledDialogPages.add(page);
  page.on("dialog", (dialog) => {
    const handled = dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss();
    void handled.catch(() => undefined);
  });
}

async function prepareProfileDirectory(profileDirectory: string): Promise<void> {
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(profileDirectory, 0o700);
}

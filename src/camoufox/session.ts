import {
  agentBrowserProxy,
  rememberBrowserProxy,
  validateBrowserProxy,
  type BrowserProxy,
} from "../runtime/proxy.js";
import { chmod, mkdir } from "node:fs/promises";
import { Camoufox, NewBrowser, launchOptions } from "camoufox-js";
import { firefox, type Browser, type BrowserContext, type Page } from "playwright";
import { BrowserResponseCache } from "../runtime/assets.js";
import { PAGE_SIGNAL_INIT } from "../runtime/degraded.js";
import { configurePageHumanization } from "../runtime/humanize.js";
import {
  MOSAIK_CAMOUFOX_OPTIONS_ENV,
  ephemeralSession,
  type BrowserSession,
  type InteractiveBrowserSession,
} from "../runtime/session.js";
import {
  toCamoufoxLaunchOptions,
  type CamoufoxOptions,
  type CamoufoxLaunchOptions,
} from "./options.js";

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
  proxy?: BrowserProxy;
}

export async function openCamoufoxBrowserSession(
  options: CamoufoxBrowserSessionOptions = {},
): Promise<CamoufoxBrowserSession | CamoufoxInteractiveBrowserSession> {
  if (options.proxy !== undefined) validateBrowserProxy(options.proxy);
  if (options.profileDirectory !== undefined) {
    return openCamoufoxInteractiveBrowserSession({
      startUrl: options.startUrl ?? "about:blank",
      profileDirectory: options.profileDirectory,
      headless: options.headless ?? true,
      ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
      ...(options.humanize === undefined ? {} : { humanize: options.humanize }),
      ...(options.camoufox === undefined ? {} : { camoufox: options.camoufox }),
    });
  }
  const camoufox = options.camoufox ?? {};
  const proxyOptions =
    options.proxy === undefined ? {} : { proxy: validateBrowserProxy(options.proxy) };
  const launch = toCamoufoxLaunchOptions(camoufox, {
    headless: options.headless ?? true,
    ...proxyOptions,
  });
  const browser = (await launchCamoufox(launch)) as Browser;
  const session = ephemeralSession(browser, {
    ...proxyOptions,
    ...(options.humanize === undefined ? {} : { humanize: options.humanize }),
  });
  return {
    ...session,
    provider: "camoufox",
    ...proxyOptions,
    camoufox,
  };
}

export async function openCamoufoxInteractiveBrowserSession(options: {
  startUrl: string;
  profileDirectory: string;
  headless?: boolean;
  humanize?: boolean;
  camoufox?: CamoufoxOptions;
  proxy?: BrowserProxy;
}): Promise<CamoufoxInteractiveBrowserSession> {
  await prepareProfileDirectory(options.profileDirectory);
  const camoufox = options.camoufox ?? {};
  const proxyOptions =
    options.proxy === undefined ? {} : { proxy: validateBrowserProxy(options.proxy) };
  const launch = toCamoufoxLaunchOptions(camoufox, {
    ...proxyOptions,
    headless: options.headless ?? false,
    userDataDir: options.profileDirectory,
  });
  const context = (await launchCamoufox(launch)) as BrowserContext;
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
    ...proxyOptions,
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
  const proxy = agentBrowserProxy();
  const launch = toCamoufoxLaunchOptions(camoufox, {
    headless: true,
    ...(proxy === undefined ? {} : { proxy }),
  });
  const browser = (await launchCamoufox(launch)) as Browser;
  rememberBrowserProxy(browser, proxy);
  return browser;
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

async function launchCamoufox(options: CamoufoxLaunchOptions): Promise<Browser | BrowserContext> {
  if (options.proxy === undefined) return Camoufox(options);
  const { user_data_dir, ...input } = options;
  const resolved = await launchOptions(input);
  // camoufox-js 0.12 converts proxy URLs through URL.origin ("null" for SOCKS5)
  // and leaves credentials URL-encoded. Preserve the original Playwright settings.
  return NewBrowser(
    firefox,
    options.headless ?? true,
    {
      ...resolved,
      proxy: options.proxy,
    },
    user_data_dir ?? false,
  );
}

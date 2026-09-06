import Kernel from "@onkernel/sdk";
import { chromium } from "playwright";
import { ephemeralSession, sharedContextSession, type BrowserSession } from "../runtime/session.js";

export interface KernelBrowserSessionOptions {
  client?: Kernel;
  invocationId?: string;
  headless?: boolean;
  humanize?: boolean;
  stealth?: boolean;
  timeoutSeconds?: number;
  profileName?: string;
  saveProfileChanges?: boolean;
}

export interface KernelBrowserSession extends BrowserSession {
  readonly provider: "kernel";
  readonly sessionId: string;
  readonly liveViewUrl?: string;
  readonly cdpEndpoint: string;
}

export async function openKernelBrowserSession(
  options: KernelBrowserSessionOptions = {},
): Promise<KernelBrowserSession> {
  const client = options.client ?? new Kernel();
  const created = await client.browsers.create({
    headless: options.headless ?? false,
    stealth: options.stealth ?? false,
    timeout_seconds: options.timeoutSeconds ?? 300,
    ...(options.invocationId === undefined ? {} : { invocation_id: options.invocationId }),
    ...(options.profileName === undefined
      ? {}
      : {
          profile: {
            name: options.profileName,
            save_changes: options.saveProfileChanges ?? true,
          },
        }),
  });

  let browser;
  try {
    browser = await chromium.connectOverCDP(created.cdp_ws_url);
  } catch (error) {
    await client.browsers.deleteByID(created.session_id).catch(() => {});
    throw error;
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await browser.close();
    } finally {
      await client.browsers.deleteByID(created.session_id).catch((error: unknown) => {
        if (!isAlreadyDeleted(error)) throw error;
      });
    }
  };
  // Kernel loads authenticated profile state into its existing context. Runs
  // without a profile stay isolated in a new context for each task.
  const session =
    options.profileName === undefined
      ? ephemeralSession(browser, {
          cdpEndpoint: created.cdp_ws_url,
          close,
          ...(options.humanize === undefined ? {} : { humanize: options.humanize }),
        })
      : await sharedContextSession(browser, {
          cdpEndpoint: created.cdp_ws_url,
          close,
          ...(options.humanize === undefined ? {} : { humanize: options.humanize }),
        });

  return {
    ...session,
    provider: "kernel",
    sessionId: created.session_id,
    cdpEndpoint: created.cdp_ws_url,
    ...(created.browser_live_view_url === undefined
      ? {}
      : { liveViewUrl: created.browser_live_view_url }),
  };
}

function isAlreadyDeleted(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const status = "status" in error ? (error as { status?: unknown }).status : undefined;
  return status === 404 || status === 410;
}

import type { Browser } from "playwright";

/** Browser traffic only; credentials are separate from the server URL. */
export interface BrowserProxy {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export const MOSAIK_BROWSER_PROXY_ENV = "MOSAIK_BROWSER_PROXY";
// CDP connections do not inherit Playwright proxy credentials for new contexts.
// Associate them with the attached browser so agent tools can apply them explicitly.
const browserProxies = new WeakMap<Browser, BrowserProxy>();

export function rememberBrowserProxy(browser: Browser, proxy: BrowserProxy | undefined): void {
  if (proxy !== undefined) browserProxies.set(browser, proxy);
}

export function browserProxyOptions(browser: Browser): { proxy?: BrowserProxy } {
  const proxy = browserProxies.get(browser);
  return proxy === undefined ? {} : { proxy };
}

export function agentBrowserProxy(): BrowserProxy | undefined {
  const source = process.env[MOSAIK_BROWSER_PROXY_ENV];
  if (!source) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${MOSAIK_BROWSER_PROXY_ENV} must contain valid JSON`);
  }
  return validateBrowserProxy(value);
}

export function validateBrowserProxy(value: unknown): BrowserProxy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("proxy must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["server", "bypass", "username", "password"].includes(key)) {
      throw new Error("proxy contains an unknown option");
    }
  }
  if (typeof record.server !== "string" || !record.server.trim()) {
    throw new Error("proxy.server must be a non-empty string");
  }
  let url: URL;
  try {
    url = new URL(record.server.includes("://") ? record.server : `http://${record.server}`);
  } catch {
    throw new Error("proxy.server must be an HTTP(S) or SOCKS5 server URL");
  }
  if (
    !["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "proxy.server must be an HTTP(S) or SOCKS5 server URL without credentials or a path",
    );
  }
  // Browsers use socks5 for remote destination DNS; socks5h is the curl spelling.
  const proxy: BrowserProxy = {
    server: url.protocol === "socks5h:" ? `socks5://${url.host}` : record.server.trim(),
  };
  for (const key of ["bypass", "username", "password"] as const) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== "string") throw new Error(`proxy.${key} must be a string`);
    proxy[key] = record[key];
  }
  if (
    (url.protocol === "socks5:" || url.protocol === "socks5h:") &&
    (proxy.username !== undefined || proxy.password !== undefined)
  ) {
    throw new Error(
      "Playwright does not support SOCKS5 proxy authentication; use an HTTP(S) proxy or a local relay that authenticates to your SOCKS5 upstream",
    );
  }
  return proxy;
}

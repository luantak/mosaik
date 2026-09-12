import { resolve } from "node:path";

export function profileDirectoryName(targetUrl: string): string {
  const url = new URL(targetUrl);
  return `${url.hostname}${url.port.length === 0 ? "" : `-${url.port}`}`.replace(
    /[^a-zA-Z0-9.-]+/g,
    "-",
  );
}

export function localBrowserProfileDirectory(dataDirectory: string, targetUrl: string): string {
  return resolve(dataDirectory, "browser-profiles", profileDirectoryName(targetUrl));
}

export function camoufoxBrowserProfileDirectory(dataDirectory: string, targetUrl: string): string {
  return resolve(dataDirectory, "camoufox-profiles", profileDirectoryName(targetUrl));
}

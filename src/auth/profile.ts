import { resolve } from "node:path";

export function localBrowserProfileDirectory(dataDirectory: string, targetUrl: string): string {
  const url = new URL(targetUrl);
  const name = `${url.hostname}${url.port.length === 0 ? "" : `-${url.port}`}`.replace(
    /[^a-zA-Z0-9.-]+/g,
    "-",
  );
  return resolve(dataDirectory, "browser-profiles", name);
}

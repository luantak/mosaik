import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";

export interface FixtureRoute {
  status?: number;
  html?: string;
  body?: string | Uint8Array;
  contentType?: string;
  file?: string;
}

export interface FixtureServer {
  url: string;
  origin: string;
  update(path: string, route: FixtureRoute): Promise<void>;
  requestCount(path: string): number;
  close(): Promise<void>;
}

export async function startFixtureServer(
  routes: Record<string, FixtureRoute>,
  options: { port?: number } = {},
): Promise<FixtureServer> {
  const resolved: Record<string, { status: number; body: string | Uint8Array; type: string }> = {};
  const requestCounts = new Map<string, number>();
  const apply = async (path: string, route: FixtureRoute): Promise<void> => {
    const body =
      route.body ??
      route.html ??
      (route.file === undefined ? "" : await readFile(route.file, "utf8"));
    resolved[path] = {
      status: route.status ?? 200,
      body,
      type: route.contentType ?? "text/html; charset=utf-8",
    };
  };
  for (const [path, route] of Object.entries(routes)) {
    await apply(path, route);
  }

  const server = createServer((request, response) => {
    const path = request.url === undefined ? "/" : (request.url.split("?")[0] ?? "/");
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
    const route = resolved[path];
    if (route === undefined) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(route.status, {
      "content-type": route.type,
      "cache-control": "no-store",
    });
    response.end(route.body);
  });
  await listen(server, options.port ?? 0);
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    url: `${origin}/`,
    update: apply,
    requestCount: (path) => requestCounts.get(path) ?? 0,
    close: () => closeServer(server),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

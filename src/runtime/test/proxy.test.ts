import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { inspectCamoufoxInstall } from "../../camoufox/install.js";
import {
  browserSessionEnvironment,
  openAgentBrowser,
  openBrowserSession,
  openInteractiveBrowserSession,
} from "../session.js";
import { browserProxyOptions, validateBrowserProxy } from "../proxy.js";

const camoufox = await inspectCamoufoxInstall();

for (const browser of ["local", "camoufox"] as const) {
  for (const persistent of [false, true]) {
    test.skipIf(browser === "camoufox" && !camoufox.ready)(
      `${browser} ${persistent ? "persistent" : "ephemeral"} sessions and agents use an authenticated proxy`,
      async () => {
        const requests: string[] = [];
        const server = createServer((request, response) => {
          if (
            request.headers["proxy-authorization"] !==
            `Basic ${Buffer.from("user:p@ss:word").toString("base64")}`
          ) {
            response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="mosaik-test"' });
            response.end();
            return;
          }
          requests.push(request.url ?? "");
          response.writeHead(200, { "Content-Type": "text/html" });
          response.end("<!doctype html><title>Via authenticated proxy</title>");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const proxy = {
          server: `http://127.0.0.1:${address.port}`,
          username: "user",
          password: "p@ss:word",
        };
        const directory = await mkdtemp(join(tmpdir(), "mosaik-proxy-"));
        const previousEnv = { ...process.env };
        let session;
        try {
          session = persistent
            ? await openInteractiveBrowserSession({
                browser,
                proxy,
                headless: true,
                profileDirectory: directory,
                startUrl: "http://mosaik-proxy.test/start",
              })
            : await openBrowserSession({ browser, proxy });
          await session.withPage(async (page) => {
            await page.goto("http://mosaik-proxy.test/runtime");
            assert.equal(await page.title(), "Via authenticated proxy");
          });
          Object.assign(process.env, browserSessionEnvironment(session));
          const agent = await openAgentBrowser();
          try {
            const context = await agent.newContext(browserProxyOptions(agent));
            try {
              const page = await context.newPage();
              await page.goto("http://mosaik-proxy.test/agent");
              assert.equal(await page.title(), "Via authenticated proxy");
            } finally {
              await context.close();
            }
          } finally {
            await agent.close();
          }
          assert.ok(requests.includes("http://mosaik-proxy.test/runtime"));
          assert.ok(requests.includes("http://mosaik-proxy.test/agent"));
          if (persistent) assert.ok(requests.includes("http://mosaik-proxy.test/start"));
        } finally {
          process.env = previousEnv;
          await session?.close();
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          await rm(directory, { recursive: true, force: true });
        }
      },
      60_000,
    );
  }
}

test("proxy validation accepts supported servers and rejects malformed settings without exposing secrets", () => {
  for (const server of [
    "http://proxy.test:8080",
    "https://proxy.test:443",
    "socks5://proxy.test:1080",
    "proxy.test:8080",
  ]) {
    assert.deepEqual(validateBrowserProxy({ server, bypass: ".example.test" }), {
      server,
      bypass: ".example.test",
    });
  }
  for (const value of [
    null,
    [],
    {},
    { server: "ftp://proxy.test" },
    { server: "http://user:p@ss:word@proxy.test" },
    { server: "http://proxy.test/path" },
    { server: "http://proxy.test", password: 123 },
    { server: "socks5://proxy.test", username: "secret" },
    { server: "http://proxy.test", passwrod: "secret" },
  ]) {
    assert.throws(
      () => validateBrowserProxy(value),
      (error: unknown) => error instanceof Error && !error.message.includes("secret"),
    );
  }
});

test("socks5h aliases normalize to socks5 and still reject credentials", () => {
  assert.deepEqual(validateBrowserProxy({ server: "socks5h://proxy.test:1080" }), {
    server: "socks5://proxy.test:1080",
  });
  assert.throws(
    () => validateBrowserProxy({ server: "socks5h://proxy.test:1080", password: "secret" }),
    /Playwright does not support SOCKS5 proxy authentication/,
  );
});

for (const browser of ["local", "camoufox"] as const) {
  for (const persistent of [false, true]) {
    for (const scheme of ["socks5", "socks5h"]) {
      test.skipIf(browser === "camoufox" && !camoufox.ready)(
        `${browser} ${persistent ? "persistent" : "ephemeral"} ${scheme} sends destination hostnames to the proxy`,
        async () => {
          const { createServer } = await import("node:net");
          const sockets = new Set<import("node:net").Socket>();
          const destinations: string[] = [];
          const server = createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            socket.on("error", () => {});
            let pending = Buffer.alloc(0);
            let stage = "greeting";
            socket.on("data", (chunk) => {
              pending = Buffer.concat([pending, chunk]);
              if (stage === "greeting") {
                if (pending.length < 2 || pending.length < 2 + pending[1]!) return;
                pending = pending.subarray(2 + pending[1]!);
                socket.write(Buffer.from([5, 0]));
                stage = "connect";
              }
              if (stage === "connect") {
                if (pending.length < 5) return;
                // Only accept domain-name CONNECT requests. Local DNS resolution
                // would send an IPv4/IPv6 address instead and fail this fixture.
                if (pending[0] !== 5 || pending[1] !== 1 || pending[3] !== 3) {
                  socket.destroy();
                  return;
                }
                const length = pending[4]!;
                if (pending.length < 7 + length) return;
                destinations.push(pending.subarray(5, 5 + length).toString());
                pending = pending.subarray(7 + length);
                socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
                stage = "http";
              }
              if (stage === "http" && pending.includes("\r\n\r\n")) {
                stage = "done";
                const body = "<title>Remote DNS</title>";
                socket.end(
                  `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n${body}`,
                );
              }
            });
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          assert.ok(address && typeof address !== "string");
          const proxy = { server: `${scheme}://127.0.0.1:${address.port}` };
          const directory = await mkdtemp(join(tmpdir(), "mosaik-socks-"));
          const previousEnv = { ...process.env };
          let session;
          try {
            session = persistent
              ? await openInteractiveBrowserSession({
                  browser,
                  proxy,
                  headless: true,
                  profileDirectory: directory,
                  startUrl: "http://start.mosaik.invalid",
                })
              : await openBrowserSession({ browser, proxy });
            await session.withPage(async (page) => {
              await page.goto("http://runtime.mosaik.invalid");
              assert.equal(await page.title(), "Remote DNS");
            });
            Object.assign(process.env, browserSessionEnvironment(session));
            const agent = await openAgentBrowser();
            try {
              const context = await agent.newContext(browserProxyOptions(agent));
              try {
                const page = await context.newPage();
                await page.goto("http://agent.mosaik.invalid");
                assert.equal(await page.title(), "Remote DNS");
              } finally {
                await context.close();
              }
            } finally {
              await agent.close();
            }
            assert.ok(destinations.includes("runtime.mosaik.invalid"));
            assert.ok(destinations.includes("agent.mosaik.invalid"));
            if (persistent) assert.ok(destinations.includes("start.mosaik.invalid"));
          } finally {
            process.env = previousEnv;
            await session?.close();
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
          }
        },
        60_000,
      );
    }
  }
}

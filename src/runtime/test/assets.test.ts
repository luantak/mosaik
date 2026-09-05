import assert from "node:assert/strict";
import { test } from "vitest";
import { chromium } from "playwright";
import { BrowserResponseCache } from "../assets.js";
import { startFixtureServer } from "../fixtures.js";

test("response cache reuses loaded resources and browser-loads cache misses", async () => {
  const cover = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path d="M0 0h2v2H0z"/></svg>',
  );
  const manual = Buffer.from("%PDF-1.4\n% fixture\n%%EOF\n");
  const fixture = await startFixtureServer({
    "/": { html: '<img src="/cover.svg"><a href="/manual.pdf">Manual</a>' },
    "/cover.svg": { body: cover, contentType: "image/svg+xml" },
    "/manual.pdf": { body: manual, contentType: "application/pdf" },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const responses = new BrowserResponseCache(page, { networkOrigin: fixture.origin });
    try {
      await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
      const coverUrl = await page
        .locator("img")
        .evaluate((image) => (image as HTMLImageElement).currentSrc);
      const manualUrl = await page
        .locator("a")
        .evaluate((link) => (link as HTMLAnchorElement).href);

      const loaded = await responses.read(coverUrl, { reuseOnly: true });
      assert.deepEqual(Buffer.from(loaded.bytes), cover);
      assert.equal(fixture.requestCount("/cover.svg"), 1);

      const fetched = await responses.read(manualUrl);
      assert.deepEqual(Buffer.from(fetched.bytes), manual);
      assert.equal(fixture.requestCount("/manual.pdf"), 1);
    } finally {
      responses.close();
      await context.close();
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("discarded response bodies fall back once while reuse-only and origin gates remain enforced", async () => {
  const { EventEmitter } = await import("node:events");
  const page = new EventEmitter();
  let requests = 0;
  const bytes = Buffer.from("image bytes");
  Object.assign(page, {
    url: () => "https://example.com/detail",
    context: () => ({
      request: {
        get: async (url: string) => {
          requests++;
          return {
            ok: () => true,
            url: () => url,
            headers: () => ({ "content-type": "image/jpeg" }),
            body: async () => bytes,
            dispose: async () => {},
          };
        },
      },
    }),
  });
  const cache = new BrowserResponseCache(page as unknown as import("playwright").Page);
  const emitResponse = (url: string, status = 200) =>
    page.emit("response", {
      url: () => url,
      status: () => status,
      finished: async () => null,
      body: async () => {
        throw new Error("Network.getResponseBody: No resource with given identifier found");
      },
    });
  try {
    emitResponse("https://example.com/cover.jpg");
    await assert.rejects(
      cache.read("https://example.com/cover.jpg", { reuseOnly: true }),
      /No resource/,
    );
    assert.equal(requests, 0);
    const results = await Promise.all([
      cache.read("https://example.com/cover.jpg"),
      cache.read("https://example.com/cover.jpg"),
    ]);
    for (const result of results) assert.deepEqual(result.bytes, bytes);
    assert.equal(requests, 1);
    assert.deepEqual(
      (await cache.read("https://example.com/cover.jpg", { reuseOnly: true })).bytes,
      bytes,
    );
    emitResponse("https://other.example/cover.jpg");
    await assert.rejects(
      cache.read("https://other.example/cover.jpg"),
      /cross-origin loading is blocked/,
    );
    emitResponse("https://example.com/denied.jpg", 403);
    await assert.rejects(cache.read("https://example.com/denied.jpg"), /HTTP 403/);
    assert.equal(requests, 1);
  } finally {
    cache.close();
  }
});

test("response cache replaces and evicts bytes without exhausting later downloads", async () => {
  const { EventEmitter } = await import("node:events");
  const page = new EventEmitter();
  const bytes = Buffer.alloc(8 * 1024 * 1024);
  let disposed = 0;
  Object.assign(page, {
    url: () => "https://example.com/",
    context: () => ({
      request: {
        get: async (url: string) => ({
          ok: () => true,
          url: () => url,
          headers: () => ({}),
          body: async () => bytes,
          dispose: async () => {
            disposed++;
          },
        }),
      },
    }),
  });
  const cache = new BrowserResponseCache(page as unknown as import("playwright").Page);
  const emit = (url: string) =>
    page.emit("response", {
      url: () => url,
      status: () => 200,
      finished: async () => null,
      body: async () => bytes,
      headers: () => ({}),
    });
  try {
    for (let i = 0; i < 12; i++) {
      emit("https://example.com/repeated");
      assert.equal(
        (await cache.read("https://example.com/repeated", { reuseOnly: true })).bytes.length,
        bytes.length,
      );
    }
    for (let i = 0; i < 12; i++) {
      const url = "https://example.com/image/" + i;
      emit(url);
      await cache.read(url, { reuseOnly: true });
    }
    await assert.rejects(
      cache.read("https://example.com/image/0", { reuseOnly: true }),
      /not loaded/,
    );
    assert.equal((await cache.read("https://example.com/image/0")).bytes.length, bytes.length);
    assert.equal(disposed, 1);
    page.emit("response", {
      url: () => "https://example.com/oversize",
      status: () => 200,
      finished: async () => null,
      body: async () => Buffer.alloc(11 * 1024 * 1024),
      headers: () => ({}),
    });
    await assert.rejects(cache.read("https://example.com/oversize"), /10 MB file limit/);
    emit("https://example.com/after");
    await cache.read("https://example.com/after", { reuseOnly: true });
  } finally {
    cache.close();
  }
});

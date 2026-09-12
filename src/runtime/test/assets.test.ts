import assert from "node:assert/strict";
import { test, vi } from "vitest";
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
      request: () => ({}),
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
      request: () => ({}),
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
      request: () => ({}),
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

for (const stalledPhase of [
  "finished",
  "body",
  "before-response",
  "failed-finished",
  "failed-body",
  "closed-body",
] as const) {
  test(`response cache recovers when a resource stalls at ${stalledPhase}`, async () => {
    const { EventEmitter } = await import("node:events");
    const page = new EventEmitter();
    const url = "https://example.com/cover.jpg";
    const bytes = Buffer.from("fallback bytes");
    let requests = 0;
    let finishCapture!: () => void;
    const stalled = new Promise<void>((resolve) => {
      finishCapture = resolve;
    });
    Object.assign(page, {
      url: () => "https://example.com/",
      context: () => ({
        request: {
          get: async () => {
            requests++;
            return {
              ok: () => true,
              url: () => url,
              headers: () => ({}),
              body: async () => bytes,
              dispose: async () => {},
            };
          },
        },
      }),
    });
    vi.useFakeTimers();
    const cache = new BrowserResponseCache(page as unknown as import("playwright").Page);
    try {
      const request = { url: () => url };
      page.emit("request", request);
      if (stalledPhase !== "before-response") {
        page.emit("response", {
          url: () => url,
          status: () => 200,
          request: () => request,
          headers: () => ({}),
          finished: async () => {
            if (stalledPhase.endsWith("finished")) await stalled;
            return null;
          },
          body: async () => {
            if (stalledPhase.endsWith("body")) await stalled;
            return Buffer.from("late bytes");
          },
        });
      }
      const reuse = assert.rejects(
        cache.read(url, { reuseOnly: true }),
        stalledPhase === "before-response"
          ? /not loaded/
          : stalledPhase.startsWith("failed-")
            ? /request failed/
            : stalledPhase === "closed-body"
              ? /cache is closed/
              : /Timed out/,
      );
      const reads = Promise.all([cache.read(url), cache.read(url)]);
      if (stalledPhase === "closed-body") {
        const rejected = assert.rejects(reads, /cache is closed/);
        await vi.advanceTimersByTimeAsync(0);
        cache.close();
        await rejected;
        await reuse;
        assert.equal(requests, 0);
        assert.equal(vi.getTimerCount(), 0);
        return;
      }
      const cancelled = stalledPhase === "before-response" || stalledPhase.startsWith("failed-");
      await vi.advanceTimersByTimeAsync(0);
      if (cancelled) page.emit("requestfailed", request);
      await vi.advanceTimersByTimeAsync(cancelled ? 10 : 5_000);
      await reuse;
      for (const response of await reads) assert.deepEqual(response.bytes, bytes);
      assert.equal(requests, 1);
      finishCapture();
      await vi.advanceTimersByTimeAsync(0);
      assert.deepEqual((await cache.read(url, { reuseOnly: true })).bytes, bytes);
    } finally {
      finishCapture();
      cache.close();
      vi.useRealTimers();
    }
  });
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { chromium } from "playwright";
import {
  browserSessionEnvironment,
  openBrowserSession,
  openInteractiveBrowserSession,
  sharedContextSession,
} from "../session.js";
import { startFixtureServer } from "../fixtures.js";
import { isPageHumanized } from "../humanize.js";

test("default local browser sessions discard state between tasks", async () => {
  const fixture = await startFixtureServer({
    "/": { html: "<!doctype html><title>Session test</title>" },
  });
  const session = await openBrowserSession();
  try {
    await session.withPage(async (page) => {
      await page.goto(fixture.url);
      await page.evaluate(() => localStorage.setItem("temporary", "value"));
    });
    await session.withPage(async (page) => {
      await page.goto(fixture.url);
      assert.equal(await page.evaluate(() => localStorage.getItem("temporary")), null);
    });
  } finally {
    await session.close();
    await fixture.close();
  }
});

test("default local browser sessions keep one window while a task runs", async () => {
  const session = await openBrowserSession({ headless: true });
  try {
    await session.withPage(async (page) => {
      const browser = page.context().browser();
      assert.ok(browser);
      const openPages = browser
        .contexts()
        .flatMap((context) => context.pages().filter((candidate) => !candidate.isClosed()));
      assert.equal(openPages.length, 1);
      assert.equal(openPages[0], page);
    });
  } finally {
    await session.close();
  }
});

test("interactive browser sessions open immediately and keep the same page", async () => {
  const fixture = await startFixtureServer({
    "/": { html: "<!doctype html><title>Interactive session</title><main>start</main>" },
  });
  const profileDirectory = await mkdtemp(join(tmpdir(), "mosaik-interactive-"));
  const session = await openInteractiveBrowserSession({
    startUrl: fixture.url,
    profileDirectory,
    headless: true,
  });
  try {
    assert.equal(session.currentUrl(), fixture.url);
    await session.withPage(async (page) => {
      assert.equal(
        page
          .context()
          .pages()
          .filter((candidate) => !candidate.isClosed()).length,
        1,
      );
      await page.locator("main").evaluate((element) => (element.textContent = "changed"));
    });
    await session.withPage(async (page) => {
      assert.equal(await page.locator("main").textContent(), "changed");
      assert.equal(page.url(), fixture.url);
    });
  } finally {
    await session.close();
    await fixture.close();
    await rm(profileDirectory, { recursive: true, force: true });
  }
});

test("interactive browser sessions drop leftover profile windows", async () => {
  const fixture = await startFixtureServer({
    "/": { html: "<!doctype html><title>Keep</title>" },
    "/extra": { html: "<!doctype html><title>Drop</title>" },
  });
  const profileDirectory = await mkdtemp(join(tmpdir(), "mosaik-leftover-"));
  const seed = await chromium.launchPersistentContext(profileDirectory, { headless: true });
  try {
    const first = seed.pages()[0] ?? (await seed.newPage());
    await first.goto(fixture.url, { waitUntil: "domcontentloaded" });
    const extra = await seed.newPage();
    await extra.goto(new URL("/extra", fixture.url).href, { waitUntil: "domcontentloaded" });
    assert.ok(seed.pages().length >= 2);
  } finally {
    await seed.close();
  }
  const session = await openInteractiveBrowserSession({
    startUrl: fixture.url,
    profileDirectory,
    headless: true,
  });
  try {
    await session.withPage(async (page) => {
      assert.equal(
        page
          .context()
          .pages()
          .filter((candidate) => !candidate.isClosed()).length,
        1,
      );
    });
  } finally {
    await session.close();
    await fixture.close();
    await rm(profileDirectory, { recursive: true, force: true });
  }
});

test("shared-context sessions retain authentication state between tasks", async () => {
  const fixture = await startFixtureServer({
    "/": { html: "<!doctype html><title>Shared context</title>" },
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const profilePage = await context.newPage();
  await profilePage.goto(fixture.url);
  await context.addCookies([
    {
      name: "session",
      value: "authenticated",
      url: fixture.url,
    },
  ]);
  const session = await sharedContextSession(browser);
  try {
    let firstPage: typeof profilePage | undefined;
    await session.withPage(async (page) => {
      firstPage = page;
      assert.equal(await page.evaluate(() => document.cookie), "session=authenticated");
      await page.evaluate(() => sessionStorage.setItem("account", "signed-in"));
    });
    await session.withPage(async (page) => {
      assert.equal(page, firstPage);
      assert.equal(await page.evaluate(() => sessionStorage.getItem("account")), "signed-in");
    });
  } finally {
    await session.close();
    await fixture.close();
  }
});

test("browser session environment exposes Camoufox options instead of a CDP endpoint", () => {
  assert.deepEqual(
    browserSessionEnvironment({
      kind: "ephemeral",
      provider: "camoufox",
      camoufox: { os: "linux", humanize: true },
      withPage: async <T>(): Promise<T> => {
        throw new Error("not used");
      },
      close: async () => {},
    }),
    {
      MOSAIK_BROWSER: "camoufox",
      MOSAIK_CAMOUFOX_OPTIONS: JSON.stringify({ os: "linux", humanize: true }),
    },
  );
});

test("browser session environment exposes only an explicit CDP endpoint", () => {
  assert.deepEqual(
    browserSessionEnvironment({
      kind: "ephemeral",
      cdpEndpoint: "wss://browser.example.test/token",
      withPage: async <T>(): Promise<T> => {
        throw new Error("not used");
      },
      close: async () => {},
    }),
    { MOSAIK_CDP_WS_URL: "wss://browser.example.test/token" },
  );
});

test("browser sessions humanize pages only when enabled", async () => {
  const regular = await openBrowserSession();
  const humanized = await openBrowserSession({ humanize: true });
  try {
    await regular.withPage(async (page) => assert.equal(isPageHumanized(page), false));
    await humanized.withPage(async (page) => assert.equal(isPageHumanized(page), true));
  } finally {
    await Promise.all([regular.close(), humanized.close()]);
  }
});

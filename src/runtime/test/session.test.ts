import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
  browserSessionEnvironment,
  openBrowserSession,
  openInteractiveBrowserSession,
  sharedContextSession,
} from "../session.js";
import { startFixtureServer } from "../fixtures.js";

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

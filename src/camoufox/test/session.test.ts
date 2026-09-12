import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  browserSessionEnvironment,
  openAgentBrowser,
  openBrowserSession,
  openInteractiveBrowserSession,
} from "../../runtime/session.js";
import { isPageHumanized } from "../../runtime/humanize.js";
import { startFixtureServer } from "../../runtime/fixtures.js";
import { inspectCamoufoxInstall } from "../install.js";
import { toCamoufoxLaunchOptions } from "../options.js";

const camoufox = await inspectCamoufoxInstall();

test.skipIf(!camoufox.ready)(
  "Camoufox sessions launch through camoufox-js and do not expose a CDP endpoint",
  async () => {
    const fixture = await startFixtureServer({
      "/": { html: "<!doctype html><title>Camoufox session</title><main>ready</main>" },
    });
    const session = await openBrowserSession({
      browser: "camoufox",
      headless: true,
      camoufox: { os: "linux", humanize: false, geoip: false },
    });
    try {
      assert.equal(session.provider, "camoufox");
      assert.equal(session.cdpEndpoint, undefined);
      assert.deepEqual(browserSessionEnvironment(session), {
        MOSAIK_BROWSER: "camoufox",
        MOSAIK_CAMOUFOX_OPTIONS: JSON.stringify({ os: "linux", humanize: false, geoip: false }),
      });
      await session.withPage(async (page) => {
        await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
        assert.equal(await page.title(), "Camoufox session");
        assert.equal(await page.locator("main").textContent(), "ready");
      });
    } finally {
      await session.close();
      await fixture.close();
    }
  },
);

test.skipIf(!camoufox.ready)(
  "persistent Camoufox sessions keep the same page without Chromium CDP",
  async () => {
    const fixture = await startFixtureServer({
      "/": { html: "<!doctype html><title>Camoufox persistent</title><main>start</main>" },
    });
    const profileDirectory = await mkdtemp(join(tmpdir(), "mosaik-camoufox-profile-"));
    const session = await openInteractiveBrowserSession({
      startUrl: fixture.url,
      profileDirectory,
      headless: true,
      browser: "camoufox",
      camoufox: { os: "linux", humanize: false, geoip: false },
    });
    try {
      assert.equal(session.provider, "camoufox");
      assert.equal(session.cdpEndpoint, undefined);
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
  },
);

test.skipIf(!camoufox.ready)(
  "mosaik humanize on Camoufox sessions uses ghost-cursor and does not enable camoufox-js humanize",
  async () => {
    const session = await openBrowserSession({
      browser: "camoufox",
      headless: true,
      humanize: true,
      camoufox: { os: "linux", geoip: false },
    });
    try {
      assert.deepEqual(session.camoufox, { os: "linux", geoip: false });
      assert.equal(toCamoufoxLaunchOptions(session.camoufox).humanize, false);
      await session.withPage(async (page) => {
        assert.equal(isPageHumanized(page), true);
      });
    } finally {
      await session.close();
    }
  },
);

test.skipIf(!camoufox.ready)(
  "DSH child browsers launch Camoufox from MOSAIK_BROWSER instead of Chromium CDP",
  async () => {
    const previousBrowser = process.env.MOSAIK_BROWSER;
    const previousOptions = process.env.MOSAIK_CAMOUFOX_OPTIONS;
    const previousCdp = process.env.MOSAIK_CDP_WS_URL;
    process.env.MOSAIK_BROWSER = "camoufox";
    process.env.MOSAIK_CAMOUFOX_OPTIONS = JSON.stringify({
      os: "linux",
      humanize: false,
      geoip: false,
    });
    delete process.env.MOSAIK_CDP_WS_URL;
    try {
      const browser = await openAgentBrowser();
      try {
        const page = await browser.newPage();
        try {
          await page.goto("about:blank");
          assert.equal(page.url(), "about:blank");
        } finally {
          await page.close();
        }
      } finally {
        await browser.close();
      }
    } finally {
      if (previousBrowser === undefined) delete process.env.MOSAIK_BROWSER;
      else process.env.MOSAIK_BROWSER = previousBrowser;
      if (previousOptions === undefined) delete process.env.MOSAIK_CAMOUFOX_OPTIONS;
      else process.env.MOSAIK_CAMOUFOX_OPTIONS = previousOptions;
      if (previousCdp === undefined) delete process.env.MOSAIK_CDP_WS_URL;
      else process.env.MOSAIK_CDP_WS_URL = previousCdp;
    }
  },
);

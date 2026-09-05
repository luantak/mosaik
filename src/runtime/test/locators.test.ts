import assert from "node:assert/strict";
import { test } from "vitest";
import { form, label, role } from "../../core/index.js";
import { startFixtureServer, withBrowser } from "../index.js";
import { resolveLocator } from "../locators.js";

test("exact role names do not match substring siblings", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: `<!doctype html><button>Continue setup</button><button>Continue</button>
        <label for="a">Email address</label><input id="a" />
        <label for="b">Email</label><input id="b" />`,
    },
  });
  try {
    await withBrowser(async (browser) => {
      const page = await (await browser.newContext()).newPage();
      await page.goto(fixture.url);
      assert.equal(await resolveLocator(page, role("button", { name: "Continue" })).count(), 1);
      assert.equal(
        await resolveLocator(page, role("button", { name: "Continue setup" })).count(),
        1,
      );
      assert.equal(
        await resolveLocator(page, role("button", { name: "Continue", exact: false })).count(),
        2,
      );
      assert.equal(await resolveLocator(page, label("Email")).count(), 1);
      assert.equal(await resolveLocator(page, label("Email address")).count(), 1);
      await page.context().close();
    });
  } finally {
    await fixture.close();
  }
});

test("scoped locators distinguish nested form fields", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: `<!doctype html>
        <form aria-label="Billing"><label for="b">Email</label><input id="b" /></form>
        <form aria-label="Shipping"><label for="s">Email</label><input id="s" /></form>`,
    },
  });
  try {
    await withBrowser(async (browser) => {
      const page = await (await browser.newContext()).newPage();
      await page.goto(fixture.url);
      const billing = resolveLocator(page, label("Email", { within: form("Billing") }));
      const shipping = resolveLocator(page, label("Email", { within: form("Shipping") }));
      const unscoped = resolveLocator(page, label("Email"));
      assert.equal(await unscoped.count(), 2);
      assert.equal(await billing.count(), 1);
      assert.equal(await shipping.count(), 1);
      assert.equal(await billing.getAttribute("id"), "b");
      assert.equal(await shipping.getAttribute("id"), "s");
      await page.context().close();
    });
  } finally {
    await fixture.close();
  }
});

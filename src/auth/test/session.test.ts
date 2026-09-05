import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { openFileRepository } from "../../persist/index.js";
import {
  openBrowserSession,
  openInteractiveBrowserSession,
  startFixtureServer,
} from "../../runtime/index.js";
import { createProfileCredentialPrompter } from "../credentials.js";
import { loginWithBrowserSession } from "../login.js";
import { applySavedAuthentication } from "../session.js";

test("saved authentication is replayed before a normal persistent session runs", async () => {
  const fixture = await startFixtureServer({
    "/login": {
      html: `<!doctype html>
        <title>Sign in</title>
        <form>
          <label>Email <input type="email" autocomplete="username" required></label>
          <label>Password <input type="password" autocomplete="current-password" required></label>
          <button>Sign in</button>
        </form>
        <script>
          if (document.cookie.includes("session=authenticated")) location.href = "/dashboard";
          document.querySelector("form").addEventListener("submit", (event) => {
            event.preventDefault();
            document.cookie = "session=authenticated; path=/; Max-Age=3600; SameSite=Lax";
            location.href = "/dashboard";
          });
        </script>`,
    },
    "/dashboard": {
      html: `<!doctype html><title>Dashboard</title><button>Log out</button>`,
    },
  });
  const root = await mkdtemp(join(tmpdir(), "mosaik-saved-auth-"));
  const profileDirectory = join(root, "browser-profile");
  const store = openFileRepository(join(root, "repository"));

  try {
    const loginSession = await openBrowserSession({ profileDirectory });
    try {
      const result = await loginWithBrowserSession(loginSession, {
        loginUrl: `${fixture.origin}/login`,
        prompter: createProfileCredentialPrompter(profileDirectory, {
          async prompt(challenge) {
            return Object.fromEntries(
              challenge.fields.map((field) => [
                field.id,
                field.kind === "password" ? "password" : "person@example.com",
              ]),
            );
          },
        }),
      });
      await store.saveAuthAutomation(result.automation);
    } finally {
      await loginSession.close();
    }

    const logoutSession = await openBrowserSession({ profileDirectory });
    try {
      await logoutSession.withPage(async (page) => {
        await page.goto(`${fixture.origin}/dashboard`);
        await page.context().clearCookies();
      });
    } finally {
      await logoutSession.close();
    }

    const normalSession = await openInteractiveBrowserSession({
      startUrl: `${fixture.origin}/login`,
      profileDirectory,
      headless: true,
    });
    try {
      let fallbackCalls = 0;
      const applied = await applySavedAuthentication(
        normalSession,
        store,
        `${fixture.origin}/login`,
        {
          async prompt() {
            fallbackCalls += 1;
            throw new Error("saved credentials should be enough");
          },
        },
      );
      assert.notEqual(applied?.login, undefined);
      assert.equal(applied?.login?.successConditionSource, "saved");
      assert.equal(fallbackCalls, 0);
      assert.equal(normalSession.currentUrl(), `${fixture.origin}/dashboard`);
      assert.equal(
        await store.siteActions.list(fixture.origin).then((actions) => actions.length),
        0,
      );
    } finally {
      await normalSession.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await fixture.close();
  }
});

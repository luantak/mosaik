import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { automation, extractText, navigate, testId } from "../../core/index.js";
import {
  executeAutomation,
  openBrowserSession,
  startFixtureServer,
  withBrowser,
} from "../../runtime/index.js";
import {
  createProfileCredentialPrompter,
  discoverAuthChallenge,
  loginWithBrowserSession,
  matchesAuthSuccessCondition,
  profileCredentialsPath,
} from "../index.js";
import type {
  AuthChallenge,
  AuthSuccessAgent,
  AuthSuccessAgentRequest,
  CredentialPrompter,
} from "../types.js";

test("login discovery exposes field metadata without exposing field values", async () => {
  const fixture = await startFixtureServer({
    "/login": {
      html: `<!doctype html>
        <title>Sign in</title>
        <form aria-label="Account sign in">
          <label>Email <input name="email" type="email" autocomplete="username" value="private@example.com" required></label>
          <label>Password <input name="password" type="password" autocomplete="current-password" value="do-not-expose" required></label>
          <button>Sign in</button>
        </form>`,
    },
  });
  try {
    await withBrowser(async (browser) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/login`);
        const challenge = await discoverAuthChallenge(page);
        assert.notEqual(challenge, null);
        assert.deepEqual(
          challenge?.fields.map(({ label, kind, required, secret }) => ({
            label,
            kind,
            required,
            secret,
          })),
          [
            { label: "Email", kind: "username", required: true, secret: false },
            { label: "Password", kind: "password", required: true, secret: true },
          ],
        );
        const serialized = JSON.stringify(challenge);
        assert.equal(serialized.includes("private@example.com"), false);
        assert.equal(serialized.includes("do-not-expose"), false);
        assert.equal(serialized.includes("data-mosaik-auth"), false);
      } finally {
        await context.close();
      }
    });
  } finally {
    await fixture.close();
  }
});

test("login refuses an ephemeral browser session", async () => {
  const session = await openBrowserSession();
  try {
    await assert.rejects(
      loginWithBrowserSession(session, {
        loginUrl: "http://localhost:3000/login",
        prompter: { prompt: async () => ({}) },
      }),
      /persistent browser session/,
    );
  } finally {
    await session.close();
  }
});

test("trusted prompting completes multi-step login and persists a reusable browser profile", async () => {
  const password = "correct horse battery staple";
  const username = "person@example.com";
  const fixture = await startFixtureServer({
    "/login": {
      html: `<!doctype html>
        <title>Account login</title>
        <h1>Sign in</h1>
        <form id="login-step-one">
          <label>Email <input name="email" type="email" autocomplete="username" required></label>
          <button>Continue</button>
        </form>
        <script>
          document.querySelector("form").addEventListener("submit", (event) => {
            event.preventDefault();
            sessionStorage.setItem("login-user", document.querySelector("input").value);
            location.href = "/password";
          });
        </script>`,
    },
    "/password": {
      html: `<!doctype html>
        <title>Enter password</title>
        <h1>Password</h1>
        <form id="login-step-two">
          <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
          <button>Sign in</button>
          <p id="error"></p>
        </form>
        <script>
          document.querySelector("form").addEventListener("submit", (event) => {
            event.preventDefault();
            if (document.querySelector("input").value !== ${JSON.stringify(password)}) {
              document.querySelector("#error").textContent = "Invalid password";
              return;
            }
            document.cookie = "session=session-cookie-token; path=/; Max-Age=3600; SameSite=Lax";
            localStorage.setItem("auth-token", "local-storage-token");
            location.href = "/account";
          });
        </script>`,
    },
    "/account": {
      html: `<!doctype html>
        <title>Account</title>
        <button data-testid="user-menu" hidden>User menu for ${username}</button>
        <table><tbody><tr tabindex="0"><td>#115 vivid v3</td></tr></tbody></table>
        <p data-testid="protected"></p>
        <script>
          const authenticated = document.cookie.includes("session=session-cookie-token")
            && localStorage.getItem("auth-token") === "local-storage-token";
          document.querySelector("[data-testid='user-menu']").hidden = !authenticated;
          document.querySelector("[data-testid='protected']").textContent = authenticated
            ? "Authenticated account"
            : "Signed out";
        </script>`,
    },
  });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "mosaik-auth-"));
  const profileDirectory = join(temporaryDirectory, "browser-profile");
  const challenges: AuthChallenge[] = [];
  const prompter: CredentialPrompter = {
    async prompt(challenge) {
      challenges.push(structuredClone(challenge));
      const field = challenge.fields[0];
      assert.notEqual(field, undefined);
      return {
        [field!.id]: field!.kind === "password" ? password : username,
      };
    },
  };
  let agentRequest: AuthSuccessAgentRequest | undefined;
  let authenticatedPageUrl: string | undefined;
  const successAgent: AuthSuccessAgent = {
    async inferSuccess(request) {
      agentRequest = structuredClone(request);
      const marker = request.candidates.find((candidate) =>
        /user menu/i.test(candidate.description),
      );
      assert.notEqual(marker, undefined);
      return {
        authenticated: true,
        markerId: marker!.id,
        reason: "The account page has a signed-in user menu",
      };
    },
  };

  try {
    const loginSession = await openBrowserSession({ profileDirectory });
    let login: Awaited<ReturnType<typeof loginWithBrowserSession>>;
    try {
      login = await loginWithBrowserSession(loginSession, {
        loginUrl: `${fixture.origin}/login`,
        prompter: createProfileCredentialPrompter(profileDirectory, prompter),
        successAgent,
        onAuthenticatedPage(page, result) {
          authenticatedPageUrl = page.url();
          assert.equal(page.url(), result.finalUrl);
          assert.equal(
            page
              .context()
              .pages()
              .filter((candidate) => !candidate.isClosed()).length,
            1,
          );
        },
      });
    } finally {
      await loginSession.close();
    }
    assert.equal(login.profileDirectory, profileDirectory);
    assert.equal(login.steps, 2);
    assert.equal(login.finalUrl, `${fixture.origin}/account`);
    assert.equal(login.successConditionSource, "agent");
    assert.equal(authenticatedPageUrl, `${fixture.origin}/account`);
    assert.deepEqual(
      challenges.map((challenge) => challenge.fields.map((field) => field.kind)),
      [["username"], ["password"]],
    );
    assert.notEqual(agentRequest, undefined);
    assert.equal(agentRequest!.page.bodyText.includes("Authenticated account"), true);
    assert.equal(agentRequest!.page.bodyText.includes(username), false);
    assert.equal(agentRequest!.page.bodyText.includes(password), false);
    assert.equal(JSON.stringify(agentRequest).includes(username), false);
    assert.equal(JSON.stringify(agentRequest).includes(password), false);
    assert.equal(
      agentRequest!.candidates.some((candidate) => candidate.description.startsWith("row ")),
      false,
    );
    assert.equal(login.successCondition.marker?.locator.strategy, "test-id");

    const rawCredentials = await readFile(profileCredentialsPath(profileDirectory), "utf8");
    assert.equal(rawCredentials.includes(username), true);
    assert.equal(rawCredentials.includes(password), true);
    if (process.platform !== "win32") {
      assert.equal((await stat(profileCredentialsPath(profileDirectory))).mode & 0o777, 0o600);
    }

    const profileFiles = await readdir(profileDirectory, { recursive: true });
    assert.equal(
      profileFiles.some((file) => file.endsWith(".storage-state.json")),
      false,
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(profileDirectory)).mode & 0o777, 0o700);
    }

    const verify = automation("authenticated-account", () => [
      navigate({
        id: "open-account",
        url: `${fixture.origin}/account`,
        safety: "browser-local",
      }),
      extractText({
        id: "read-account",
        locator: testId("protected"),
        output: "account",
        safety: "read-only",
      }),
    ]);

    const authenticatedSession = await openBrowserSession({ profileDirectory });
    try {
      const result = await executeAutomation(authenticatedSession, verify);
      assert.equal(result.success, true);
      assert.equal(result.outputs.account, "Authenticated account");
      await authenticatedSession.withPage(async (page) => {
        await page.goto(`${fixture.origin}/account`);
        assert.equal(await matchesAuthSuccessCondition(page, login.successCondition), true);
      });
    } finally {
      await authenticatedSession.close();
    }

    const logoutSession = await openBrowserSession({ profileDirectory });
    try {
      await logoutSession.withPage(async (page) => {
        await page.goto(`${fixture.origin}/account`);
        await page.context().clearCookies();
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        assert.equal(await page.getByTestId("protected").textContent(), "Signed out");
      });
    } finally {
      await logoutSession.close();
    }

    let unexpectedPrompts = 0;
    let unexpectedAgentCalls = 0;
    const reloginSession = await openBrowserSession({ profileDirectory });
    try {
      const relogin = await loginWithBrowserSession(reloginSession, {
        loginUrl: `${fixture.origin}/login`,
        prompter: createProfileCredentialPrompter(profileDirectory, {
          async prompt() {
            unexpectedPrompts += 1;
            throw new Error("Stored username and password should have been reused");
          },
        }),
        savedAutomation: login.automation,
        successAgent: {
          async inferSuccess() {
            unexpectedAgentCalls += 1;
            throw new Error("A matching saved authentication condition should skip the agent");
          },
        },
      });
      assert.equal(relogin.steps, 2);
      assert.equal(relogin.finalUrl, `${fixture.origin}/account`);
      assert.equal(relogin.successConditionSource, "saved");
      assert.equal(unexpectedPrompts, 0);
      assert.equal(unexpectedAgentCalls, 0);
    } finally {
      await reloginSession.close();
    }

    const signedOutSession = await openBrowserSession();
    try {
      await signedOutSession.withPage(async (page) => {
        await page.goto(`${fixture.origin}/account`);
        assert.equal(await matchesAuthSuccessCondition(page, login.successCondition), false);
      });
    } finally {
      await signedOutSession.close();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await fixture.close();
  }
});

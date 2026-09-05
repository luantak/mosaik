import type { MosaikStore } from "../persist/index.js";
import type { InteractiveBrowserSession } from "../runtime/session.js";
import { createProfileCredentialPrompter } from "./credentials.js";
import { discoverAuthChallenge } from "./discovery.js";
import { loginWithBrowserSession } from "./login.js";
import { matchesAuthSuccessCondition } from "./success.js";
import type { AuthAutomation, CredentialPrompter, LoginResult } from "./types.js";

export interface SavedAuthenticationResult {
  automation: AuthAutomation;
  login?: LoginResult;
}

/**
 * Replays a saved authentication automation when the requested page presents a
 * login form. Authentication stays outside the learned site-action library.
 */
export async function applySavedAuthentication(
  session: InteractiveBrowserSession,
  store: MosaikStore,
  startUrl: string,
  fallback?: CredentialPrompter,
): Promise<SavedAuthenticationResult | undefined> {
  const automation = await findAuthAutomationForUrl(store, startUrl);
  if (automation === undefined) return undefined;

  const needsLogin = await session.withPage(async (page) => {
    if (await matchesAuthSuccessCondition(page, automation.successCondition)) return false;
    return (await discoverAuthChallenge(page)) !== null;
  });
  if (!needsLogin) return { automation };

  const unavailable: CredentialPrompter = {
    async prompt(challenge) {
      const fields = challenge.fields.map((field) => field.label).join(", ");
      throw new Error(
        `Saved login for ${new URL(automation.loginUrl).origin} needs ${fields}. Run mosaik login ${automation.loginUrl}, or use /login in an interactive session.`,
      );
    },
  };
  const login = await loginWithBrowserSession(session, {
    loginUrl: automation.loginUrl,
    prompter: createProfileCredentialPrompter(session.profileDirectory, fallback ?? unavailable),
    savedAutomation: automation,
    isAuthenticated: (page) => matchesAuthSuccessCondition(page, automation.successCondition),
    onAuthenticatedPage: async (_page, authenticated) => {
      await store.saveAuthAutomation(authenticated.automation);
    },
  });
  await session.withPage((page) =>
    page.goto(startUrl, { waitUntil: "domcontentloaded" }).then(() => undefined),
  );
  return { automation: login.automation, login };
}

export async function findAuthAutomationForUrl(
  store: Pick<MosaikStore, "getAuthAutomation" | "listAuthAutomationIds">,
  targetUrl: string,
): Promise<AuthAutomation | undefined> {
  const target = new URL(targetUrl);
  const automations = (
    await Promise.all(
      (await store.listAuthAutomationIds()).map((id) => store.getAuthAutomation(id)),
    )
  ).filter(
    (automation): automation is AuthAutomation =>
      automation !== undefined && new URL(automation.loginUrl).origin === target.origin,
  );
  automations.sort((left, right) => {
    const leftTargetsStart = sameAuthUrl(left.successCondition.targetUrl, target.href) ? 1 : 0;
    const rightTargetsStart = sameAuthUrl(right.successCondition.targetUrl, target.href) ? 1 : 0;
    return rightTargetsStart - leftTargetsStart || left.id.localeCompare(right.id);
  });
  return automations[0];
}

function sameAuthUrl(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.href;
  };
  return normalize(left) === normalize(right);
}

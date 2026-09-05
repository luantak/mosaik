import type { Locator, Page } from "playwright";
import type { BrowserSession } from "../runtime/session.js";
import { authAutomationStep, buildAuthAutomation } from "./automation.js";
import {
  AUTH_FIELD_ATTRIBUTE,
  AUTH_SUBMIT_ATTRIBUTE,
  discoverMarkedAuthChallenge,
} from "./discovery.js";
import { inferAuthSuccessCondition, matchesAuthSuccessCondition } from "./success.js";
import type { AuthAutomationStep, AuthChallenge, LoginOptions, LoginResult } from "./types.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_LOGIN_STEPS = 5;

export async function loginWithBrowserSession(
  session: BrowserSession,
  options: LoginOptions,
): Promise<LoginResult> {
  if (session.kind !== "persistent" || session.profileDirectory === undefined) {
    throw new Error("Login requires a persistent browser session");
  }
  if (options.loginUrl.trim().length === 0) throw new Error("Login URL is required");
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_LOGIN_STEPS;
  const credentialRedactions = new Set<string>();
  const observedSteps: AuthAutomationStep[] = [];
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error("maxSteps must be a positive integer");
  }

  return session.withPage(async (page) => {
    await page.goto(options.loginUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    if (await authenticated(page, options)) {
      return finishLogin(
        page,
        session.profileDirectory!,
        options,
        0,
        observedSteps,
        credentialRedactions,
      );
    }

    for (let step = 1; step <= maxSteps; step += 1) {
      const discovered = await discoverMarkedAuthChallenge(page, step);
      if (discovered === null) {
        if (
          options.successAgent !== undefined ||
          (options.isAuthenticated === undefined && step > 1)
        ) {
          return finishLogin(
            page,
            session.profileDirectory!,
            options,
            step - 1,
            observedSteps,
            credentialRedactions,
          );
        }
        throw new Error(
          step === 1
            ? "No supported login form was found on the opened page"
            : "Authentication could not be confirmed after submitting the login form",
        );
      }

      const { hasSubmit, ...challenge } = discovered;
      observedSteps.push(authAutomationStep(challenge));
      const values = await options.prompter.prompt(freezeChallenge(challenge));
      for (const value of Object.values(values)) {
        if (value.length > 0) credentialRedactions.add(value);
      }
      await fillChallenge(page, challenge, values, timeoutMs);
      await submitChallenge(page, challenge, hasSubmit, timeoutMs);

      if (await authenticated(page, options)) {
        return finishLogin(
          page,
          session.profileDirectory!,
          options,
          step,
          observedSteps,
          credentialRedactions,
        );
      }
      if (
        step === maxSteps &&
        options.isAuthenticated === undefined &&
        (await discoverMarkedAuthChallenge(page, step + 1)) === null
      ) {
        return finishLogin(
          page,
          session.profileDirectory!,
          options,
          step,
          observedSteps,
          credentialRedactions,
        );
      }
    }
    throw new Error(`Authentication did not complete within ${maxSteps} login steps`);
  });
}

async function finishLogin(
  page: Page,
  profileDirectory: string,
  options: LoginOptions,
  completedSteps: number,
  observedSteps: AuthAutomationStep[],
  credentialRedactions: Iterable<string>,
): Promise<LoginResult> {
  const savedSuccessCondition = options.savedAutomation?.successCondition;
  const savedConditionMatches =
    savedSuccessCondition !== undefined &&
    (await matchesAuthSuccessCondition(page, savedSuccessCondition));
  const successCondition = savedConditionMatches
    ? savedSuccessCondition
    : await inferAuthSuccessCondition(page, options.loginUrl, {
        ...(options.successAgent === undefined ? {} : { agent: options.successAgent }),
        redact: credentialRedactions,
      });
  if (!(await matchesAuthSuccessCondition(page, successCondition))) {
    throw new Error("The authenticated page did not match the inferred success condition");
  }
  const automation = buildAuthAutomation(
    options.loginUrl,
    observedSteps,
    successCondition,
    options.savedAutomation,
  );
  const result: LoginResult = {
    profileDirectory,
    finalUrl: page.url(),
    steps: completedSteps,
    automation,
    successCondition,
    successConditionSource: savedConditionMatches
      ? "saved"
      : options.successAgent === undefined
        ? "host"
        : "agent",
  };
  await options.onAuthenticatedPage?.(page, result);
  return result;
}

async function authenticated(page: Page, options: LoginOptions): Promise<boolean> {
  return options.isAuthenticated === undefined ? false : options.isAuthenticated(page);
}

function freezeChallenge(challenge: AuthChallenge): Readonly<AuthChallenge> {
  for (const field of challenge.fields) Object.freeze(field);
  Object.freeze(challenge.fields);
  return Object.freeze(challenge);
}

async function fillChallenge(
  page: Page,
  challenge: AuthChallenge,
  values: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  for (const field of challenge.fields) {
    const value = values[field.id];
    if (value === undefined || (field.required && value.length === 0)) {
      throw new Error(`No value was provided for required login field "${field.label}"`);
    }
    if (value === undefined) continue;
    await authField(page, field.id).fill(value, { timeout: timeoutMs });
  }
}

async function submitChallenge(
  page: Page,
  challenge: AuthChallenge,
  hasSubmit: boolean,
  timeoutMs: number,
): Promise<void> {
  const previousUrl = page.url();
  if (hasSubmit) {
    await page.locator(`[${AUTH_SUBMIT_ATTRIBUTE}="true"]`).click({ timeout: timeoutMs });
  } else {
    const last = challenge.fields.at(-1);
    if (last === undefined) throw new Error("The login form has no fields to submit");
    await authField(page, last.id).press("Enter", { timeout: timeoutMs });
  }
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  await page
    .waitForFunction(
      ({ url, attribute }) =>
        location.href !== url || document.querySelector(`[${attribute}]`) === null,
      { url: previousUrl, attribute: AUTH_FIELD_ATTRIBUTE },
      { timeout: Math.min(timeoutMs, 2_000) },
    )
    .catch(() => undefined);
}

function authField(page: Page, id: string): Locator {
  return page.locator(`[${AUTH_FIELD_ATTRIBUTE}="${id}"]`);
}

import type { LocatorDefinition } from "../core/index.js";
import { resolveLocator } from "../runtime/locators.js";
import { collectOverview } from "../runtime/overview.js";
import type { Page } from "playwright";
import { discoverAuthChallenge } from "./discovery.js";
import type {
  AuthSuccessAgent,
  AuthSuccessAgentRequest,
  AuthSuccessCandidate,
  AuthSuccessCondition,
  AuthSuccessMarker,
} from "./types.js";

interface PreparedCandidate extends AuthSuccessCandidate {
  locator: LocatorDefinition;
}

const CONTENT_ROLES = new Set(["article", "cell", "gridcell", "listitem", "row"]);

export async function inferAuthSuccessCondition(
  page: Page,
  loginUrl: string,
  options: {
    agent?: AuthSuccessAgent;
    redact?: Iterable<string>;
  } = {},
): Promise<AuthSuccessCondition> {
  const redactions = [...(options.redact ?? [])].filter((value) => value.length > 0);
  const prepared = await successCandidates(page, redactions);
  const normalizedLoginUrl = normalizeAuthUrl(loginUrl);
  const targetUrl = normalizeAuthUrl(page.url());
  const loginFormPresent = (await discoverAuthChallenge(page)) !== null;
  const title = redact(await page.title(), redactions);
  const bodyText = redact(
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
    redactions,
  ).slice(0, 20_000);
  const request: AuthSuccessAgentRequest = {
    loginUrl: normalizedLoginUrl,
    page: {
      url: targetUrl,
      title,
      bodyText,
      loginFormPresent,
    },
    candidates: prepared.map(({ id, description }) => ({ id, description })),
    credentialsRedacted: true,
  };

  const decision =
    options.agent === undefined ? hostDecision(request) : await options.agent.inferSuccess(request);
  if (!decision.authenticated) {
    throw new Error(`The authentication agent did not confirm login: ${decision.reason}`);
  }
  if (loginFormPresent) {
    throw new Error("The authentication agent cannot accept a page with a visible login form");
  }
  const selected =
    decision.markerId === undefined
      ? undefined
      : prepared.find((candidate) => candidate.id === decision.markerId);
  if (decision.markerId !== undefined && selected === undefined) {
    throw new Error(`The authentication agent selected unknown marker ${decision.markerId}`);
  }
  const marker: AuthSuccessMarker | undefined =
    selected === undefined
      ? undefined
      : {
          candidateId: selected.id,
          description: selected.description,
          locator: selected.locator,
        };
  return {
    loginUrl: normalizedLoginUrl,
    targetUrl,
    requireAuthFormAbsent: !loginFormPresent,
    confidence: marker !== undefined ? "high" : targetUrl !== normalizedLoginUrl ? "medium" : "low",
    reason: decision.reason,
    ...(marker === undefined ? {} : { marker }),
  };
}

export async function matchesAuthSuccessCondition(
  page: Page,
  condition: AuthSuccessCondition,
  expectedUrl = condition.targetUrl,
): Promise<boolean> {
  if (normalizeAuthUrl(page.url()) !== normalizeAuthUrl(expectedUrl)) return false;
  if (condition.requireAuthFormAbsent && (await discoverAuthChallenge(page)) !== null) return false;
  if (condition.marker === undefined) return true;
  const marker = resolveLocator(page, condition.marker.locator);
  return (await marker.count()) === 1 && (await marker.isVisible());
}

export function describeAuthSuccessCondition(condition: AuthSuccessCondition): string {
  const marker =
    condition.marker === undefined ? "" : ` and ${condition.marker.description} is visible`;
  return `no login form at ${condition.targetUrl}${marker} (${condition.confidence} confidence)`;
}

async function successCandidates(page: Page, redactions: string[]): Promise<PreparedCandidate[]> {
  const overview = await collectOverview(page);
  const candidates: PreparedCandidate[] = [];
  for (const item of overview.interactive) {
    if (!item.visible || !item.enabled || item.role === "textbox") continue;
    const locator = markerLocator(item);
    if (locator === undefined) continue;
    const resolved = resolveLocator(page, locator);
    if ((await resolved.count()) !== 1 || !(await resolved.isVisible())) continue;
    candidates.push({
      id: `marker-${candidates.length + 1}`,
      description: redact(markerDescription(item), redactions),
      locator,
    });
    if (candidates.length === 20) break;
  }
  return candidates;
}

function markerLocator(item: {
  testId?: string;
  role?: string;
  name?: string;
  text?: string;
}): LocatorDefinition | undefined {
  if (item.role !== undefined && CONTENT_ROLES.has(item.role)) return undefined;
  if (item.testId !== undefined) return { strategy: "test-id", testId: item.testId };
  if (item.role !== undefined && item.name !== undefined) {
    return { strategy: "role", role: item.role, name: item.name, exact: true };
  }
  if (item.text !== undefined) return { strategy: "text", text: item.text, exact: true };
  return undefined;
}

function markerDescription(item: {
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
}): string {
  const identity = item.name ?? item.text ?? item.testId ?? "unnamed control";
  return `${item.role ?? "control"} ${JSON.stringify(identity)}`;
}

function hostDecision(request: AuthSuccessAgentRequest): {
  authenticated: boolean;
  markerId?: string;
  reason: string;
} {
  if (request.page.loginFormPresent) {
    return { authenticated: false, reason: "The login form is still present" };
  }
  const likelyMarker = request.candidates.find((candidate) =>
    /sign out|log out|logout|user menu|account menu|profile menu/i.test(candidate.description),
  );
  return {
    authenticated: true,
    reason:
      likelyMarker === undefined
        ? "The login form disappeared"
        : `The login form disappeared and ${likelyMarker.description} appeared`,
    ...(likelyMarker === undefined ? {} : { markerId: likelyMarker.id }),
  };
}

function redact(value: string, redactions: string[]): string {
  let result = value;
  for (const secret of [...redactions].sort((left, right) => right.length - left.length)) {
    for (const variant of new Set([secret, encodeURIComponent(secret)])) {
      result = result.replace(new RegExp(escapeRegExp(variant), "gi"), "[credential redacted]");
    }
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeAuthUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

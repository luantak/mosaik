import type { LocatorDefinition, LocatorScope } from "../core/index.js";
import type {
  AuthAutomation,
  AuthAutomationField,
  AuthAutomationStep,
  AuthChallenge,
  AuthSuccessCondition,
} from "./types.js";

export function authAutomationId(loginUrl: string): string {
  const url = new URL(loginUrl);
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9.-]+/g, "-");
  return `auth-${url.hostname}${url.port.length === 0 ? "" : `-${url.port}`}${path ? `-${path}` : ""}`;
}

export function authAutomationStep(challenge: Readonly<AuthChallenge>): AuthAutomationStep {
  return {
    url: normalizeUrl(challenge.url),
    title: challenge.title,
    fields: challenge.fields.map(({ id: _id, ...field }) => field),
    ...(challenge.submitLabel === undefined ? {} : { submitLabel: challenge.submitLabel }),
  };
}

export function buildAuthAutomation(
  loginUrl: string,
  observedSteps: AuthAutomationStep[],
  successCondition: AuthSuccessCondition,
  previous?: AuthAutomation,
): AuthAutomation {
  const steps = observedSteps.length > 0 ? observedSteps : (previous?.steps ?? []);
  const content = { loginUrl: normalizeUrl(loginUrl), steps, successCondition };
  const previousContent =
    previous === undefined
      ? undefined
      : {
          loginUrl: previous.loginUrl,
          steps: previous.steps,
          successCondition: previous.successCondition,
        };
  const changed =
    previousContent === undefined || JSON.stringify(previousContent) !== JSON.stringify(content);
  return {
    id: authAutomationId(loginUrl),
    version: previous === undefined ? 1 : changed ? previous.version + 1 : previous.version,
    ...content,
  };
}

export function parseAuthAutomation(value: unknown): AuthAutomation {
  if (!isRecord(value)) throw new Error("Authentication automation must be an object");
  const automation: AuthAutomation = {
    id: asNonEmptyString(value.id, "id"),
    version: asPositiveInteger(value.version, "version"),
    loginUrl: asWebUrl(value.loginUrl, "loginUrl"),
    steps: asSteps(value.steps),
    successCondition: asSuccessCondition(value.successCondition),
  };
  if (automation.id !== authAutomationId(automation.loginUrl)) {
    throw new Error("Authentication automation id does not match its login URL");
  }
  return automation;
}

function asSteps(value: unknown): AuthAutomationStep[] {
  if (!Array.isArray(value)) throw new Error("Authentication automation steps must be an array");
  return value.map((step, index) => {
    if (!isRecord(step)) throw new Error(`Authentication step ${index + 1} must be an object`);
    if (!Array.isArray(step.fields)) {
      throw new Error(`Authentication step ${index + 1} fields must be an array`);
    }
    return {
      url: asWebUrl(step.url, `steps[${index}].url`),
      title: asString(step.title, `steps[${index}].title`),
      fields: step.fields.map((field, fieldIndex) => asField(field, index, fieldIndex)),
      ...(step.submitLabel === undefined
        ? {}
        : { submitLabel: asString(step.submitLabel, `steps[${index}].submitLabel`) }),
    };
  });
}

function asField(value: unknown, stepIndex: number, fieldIndex: number): AuthAutomationField {
  if (!isRecord(value))
    throw new Error(`Authentication field ${stepIndex + 1}.${fieldIndex + 1} must be an object`);
  const kind = value.kind;
  if (kind !== "username" && kind !== "password" && kind !== "one-time-code" && kind !== "text") {
    throw new Error(`Authentication field ${stepIndex + 1}.${fieldIndex + 1} has an invalid kind`);
  }
  return {
    label: asString(value.label, `steps[${stepIndex}].fields[${fieldIndex}].label`),
    kind,
    required: asBoolean(value.required, `steps[${stepIndex}].fields[${fieldIndex}].required`),
    secret: asBoolean(value.secret, `steps[${stepIndex}].fields[${fieldIndex}].secret`),
    ...(value.autocomplete === undefined
      ? {}
      : {
          autocomplete: asString(
            value.autocomplete,
            `steps[${stepIndex}].fields[${fieldIndex}].autocomplete`,
          ),
        }),
  };
}

function asSuccessCondition(value: unknown): AuthSuccessCondition {
  if (!isRecord(value)) throw new Error("Authentication success condition must be an object");
  const confidence = value.confidence;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    throw new Error("Authentication success condition has invalid confidence");
  }
  return {
    loginUrl: asWebUrl(value.loginUrl, "successCondition.loginUrl"),
    targetUrl: asWebUrl(value.targetUrl, "successCondition.targetUrl"),
    requireAuthFormAbsent: asBoolean(
      value.requireAuthFormAbsent,
      "successCondition.requireAuthFormAbsent",
    ),
    confidence,
    reason: asString(value.reason, "successCondition.reason"),
    ...(value.marker === undefined ? {} : { marker: asMarker(value.marker) }),
  };
}

function asMarker(value: unknown): NonNullable<AuthSuccessCondition["marker"]> {
  if (!isRecord(value)) throw new Error("Authentication success marker must be an object");
  return {
    candidateId: asNonEmptyString(value.candidateId, "marker.candidateId"),
    description: asNonEmptyString(value.description, "marker.description"),
    locator: asLocator(value.locator),
  };
}

function asLocator(value: unknown): LocatorDefinition {
  if (!isRecord(value)) throw new Error("Authentication marker locator must be an object");
  const within = value.within === undefined ? undefined : asScope(value.within);
  const suffix = within === undefined ? {} : { within };
  if (value.strategy === "role") {
    return {
      strategy: "role",
      role: asNonEmptyString(value.role, "marker.locator.role"),
      ...(value.name === undefined ? {} : { name: asString(value.name, "marker.locator.name") }),
      ...(value.exact === undefined
        ? {}
        : { exact: asBoolean(value.exact, "marker.locator.exact") }),
      ...suffix,
    };
  }
  if (value.strategy === "text") {
    return {
      strategy: "text",
      text: asNonEmptyString(value.text, "marker.locator.text"),
      ...(value.exact === undefined
        ? {}
        : { exact: asBoolean(value.exact, "marker.locator.exact") }),
      ...suffix,
    };
  }
  if (value.strategy === "label") {
    return {
      strategy: "label",
      label: asNonEmptyString(value.label, "marker.locator.label"),
      ...(value.exact === undefined
        ? {}
        : { exact: asBoolean(value.exact, "marker.locator.exact") }),
      ...suffix,
    };
  }
  if (value.strategy === "test-id") {
    return {
      strategy: "test-id",
      testId: asNonEmptyString(value.testId, "marker.locator.testId"),
      ...suffix,
    };
  }
  if (value.strategy === "css") {
    return {
      strategy: "css",
      selector: asNonEmptyString(value.selector, "marker.locator.selector"),
      ...suffix,
    };
  }
  throw new Error("Authentication marker locator has an invalid strategy");
}

function asScope(value: unknown): LocatorScope {
  if (!isRecord(value)) throw new Error("Authentication marker scope must be an object");
  if (value.kind === "form") {
    return { kind: "form", name: asNonEmptyString(value.name, "marker.locator.within.name") };
  }
  if (value.kind === "landmark") {
    return {
      kind: "landmark",
      role: asNonEmptyString(value.role, "marker.locator.within.role"),
      ...(value.name === undefined
        ? {}
        : { name: asString(value.name, "marker.locator.within.name") }),
    };
  }
  throw new Error("Authentication marker scope has an invalid kind");
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

function asWebUrl(value: unknown, label: string): string {
  const text = asNonEmptyString(value, label);
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  return normalizeUrl(url.href);
}

function asPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function asNonEmptyString(value: unknown, label: string): string {
  const text = asString(value, label);
  if (text.trim().length === 0) throw new Error(`${label} must not be empty`);
  return text;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

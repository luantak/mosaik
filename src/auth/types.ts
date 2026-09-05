import type { LocatorDefinition } from "../core/index.js";
import type { Page } from "playwright";

export type AuthFieldKind = "username" | "password" | "one-time-code" | "text";

export interface AuthField {
  id: string;
  label: string;
  kind: AuthFieldKind;
  required: boolean;
  secret: boolean;
  autocomplete?: string;
}

/** Safe page metadata. It deliberately contains no input values or selectors. */
export interface AuthChallenge {
  url: string;
  title: string;
  step: number;
  fields: AuthField[];
  submitLabel?: string;
}

/**
 * Implement this in trusted host code. Do not back it with an AI or include its
 * returned values in Mosaik task inputs.
 */
export interface CredentialPrompter {
  prompt(challenge: Readonly<AuthChallenge>): Promise<Record<string, string>>;
}

export type AuthAutomationField = Omit<AuthField, "id">;

export interface AuthAutomationStep {
  url: string;
  title: string;
  fields: AuthAutomationField[];
  submitLabel?: string;
}

export interface AuthAutomation {
  id: string;
  version: number;
  loginUrl: string;
  steps: AuthAutomationStep[];
  successCondition: AuthSuccessCondition;
}

export interface LoginOptions {
  loginUrl: string;
  prompter: CredentialPrompter;
  isAuthenticated?: (page: Page) => boolean | Promise<boolean>;
  successAgent?: AuthSuccessAgent;
  savedAutomation?: AuthAutomation;
  onAuthenticatedPage?: (page: Page, result: Readonly<LoginResult>) => void | Promise<void>;
  maxSteps?: number;
  timeoutMs?: number;
}

export interface LoginResult {
  profileDirectory: string;
  finalUrl: string;
  steps: number;
  automation: AuthAutomation;
  successCondition: AuthSuccessCondition;
  successConditionSource: "saved" | "agent" | "host";
}

export interface AuthSuccessMarker {
  candidateId: string;
  description: string;
  locator: LocatorDefinition;
}

export interface AuthSuccessCondition {
  loginUrl: string;
  targetUrl: string;
  requireAuthFormAbsent: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
  marker?: AuthSuccessMarker;
}

export interface AuthSuccessCandidate {
  id: string;
  description: string;
}

export interface AuthSuccessAgentRequest {
  loginUrl: string;
  page: {
    url: string;
    title: string;
    bodyText: string;
    loginFormPresent: boolean;
  };
  candidates: AuthSuccessCandidate[];
  credentialsRedacted: true;
}

export interface AuthSuccessAgentDecision {
  authenticated: boolean;
  reason: string;
  markerId?: string;
}

export interface AuthSuccessAgent {
  inferSuccess(request: AuthSuccessAgentRequest): Promise<AuthSuccessAgentDecision>;
}

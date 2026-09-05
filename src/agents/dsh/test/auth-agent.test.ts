import assert from "node:assert/strict";
import { test } from "vitest";
import type { AuthSuccessAgentRequest } from "../../../auth/index.js";
import { parseAuthSuccessAgentDecision } from "../auth-agent.js";

const request: AuthSuccessAgentRequest = {
  loginUrl: "http://localhost:3000/login",
  page: {
    url: "http://localhost:3000/account",
    title: "Account",
    bodyText: "Welcome",
    loginFormPresent: false,
  },
  candidates: [
    { id: "marker-1", description: 'button "User menu"' },
    { id: "marker-2", description: 'link "Settings"' },
  ],
  credentialsRedacted: true,
};

test("authentication agent decisions accept a supplied replay marker", () => {
  assert.deepEqual(
    parseAuthSuccessAgentDecision(
      {
        authenticated: true,
        markerId: "marker-1",
        reason: "The signed-in user menu is visible",
      },
      request,
    ),
    {
      authenticated: true,
      markerId: "marker-1",
      reason: "The signed-in user menu is visible",
    },
  );
});

test("authentication agent decisions reject invented markers and malformed output", () => {
  assert.equal(
    parseAuthSuccessAgentDecision(
      { authenticated: true, markerId: "marker-99", reason: "Invented" },
      request,
    ),
    undefined,
  );
  assert.equal(
    parseAuthSuccessAgentDecision({ authenticated: true, reason: "" }, request),
    undefined,
  );
  assert.equal(
    parseAuthSuccessAgentDecision(
      { authenticated: false, markerId: "marker-1", reason: "Still signed out" },
      request,
    ),
    undefined,
  );
});

test("authentication agent decisions can reject a page without a marker", () => {
  assert.deepEqual(
    parseAuthSuccessAgentDecision(
      { authenticated: false, reason: "The login form remains visible" },
      request,
    ),
    { authenticated: false, reason: "The login form remains visible" },
  );
});

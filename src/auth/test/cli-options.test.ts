import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { parseLoginCliArgs } from "../cli-options.js";

test("login CLI accepts a positional local URL and derives a private session path", () => {
  const parsed = parseLoginCliArgs(["http://localhost:3000/login"], "/project");
  assert.equal(parsed.help, false);
  if (parsed.help) return;
  assert.deepEqual(parsed.options, {
    loginUrl: "http://localhost:3000/login",
    dataDirectory: resolve("/project/.mosaik"),
    profileDirectory: resolve("/project/.mosaik/browser-profiles/localhost-3000"),
    headless: false,
    pause: false,
    timeoutMs: 10_000,
    maxSteps: 5,
  });
});

test("login CLI parses verification and runtime controls", () => {
  const parsed = parseLoginCliArgs(
    [
      "--url",
      "https://dev.example.test/login",
      "--profile",
      "profiles/dev",
      "--check-url",
      "https://dev.example.test/settings",
      "--timeout-ms",
      "25000",
      "--max-steps",
      "3",
      "--headless",
      "--pause",
    ],
    "/project",
  );
  assert.equal(parsed.help, false);
  if (parsed.help) return;
  assert.deepEqual(parsed.options, {
    loginUrl: "https://dev.example.test/login",
    dataDirectory: resolve("/project/.mosaik"),
    profileDirectory: resolve("/project/profiles/dev"),
    checkUrl: "https://dev.example.test/settings",
    headless: true,
    pause: true,
    timeoutMs: 25_000,
    maxSteps: 3,
  });
});

test("login CLI derives its default profile from a custom data directory", () => {
  const parsed = parseLoginCliArgs(
    ["https://example.test/login", "--data-dir", "state"],
    "/project",
  );
  assert.equal(parsed.help, false);
  if (parsed.help) return;
  assert.equal(parsed.options.dataDirectory, resolve("/project/state"));
  assert.equal(
    parsed.options.profileDirectory,
    resolve("/project/state/browser-profiles/example.test"),
  );
});

test("login CLI help does not require a URL", () => {
  assert.deepEqual(parseLoginCliArgs(["--help"]), { help: true });
  assert.deepEqual(parseLoginCliArgs(["--", "--help"]), { help: true });
});

test("login CLI rejects missing, non-web, and duplicate URLs", () => {
  assert.throws(() => parseLoginCliArgs([]), /login URL is required/);
  assert.throws(() => parseLoginCliArgs(["file:///tmp/login.html"]), /must use http or https/);
  assert.throws(
    () => parseLoginCliArgs(["http://localhost/login", "http://localhost/other"]),
    /only one login URL/,
  );
  assert.throws(
    () => parseLoginCliArgs(["http://localhost/login", "--max-steps", "0"]),
    /positive integer/,
  );
});

test("login CLI parses the Kernel hosted-login options", () => {
  const parsed = parseLoginCliArgs(
    [
      "https://example.test/login",
      "--browser",
      "kernel",
      "--domain",
      "example.test",
      "--allowed-domain",
      "idp.example.test",
      "--allowed-domain",
      "login.example.test",
      "--no-open",
      "--no-wait",
      "--json",
    ],
    "/project",
  );
  assert.equal(parsed.help, false);
  if (!parsed.help) {
    assert.equal(parsed.options.browser, "kernel");
    assert.equal(parsed.options.domain, "example.test");
    assert.deepEqual(parsed.options.allowedDomains, ["idp.example.test", "login.example.test"]);
    assert.equal(parsed.options.noOpen, true);
    assert.equal(parsed.options.noWait, true);
    assert.equal(parsed.options.json, true);
  }
});

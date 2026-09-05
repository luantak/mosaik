import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import {
  parseActionsCliArgs,
  parseDoctorCliArgs,
  parseKernelCliArgs,
  parsePullCliArgs,
  parseRunCliArgs,
} from "../cli-options.js";

test("run CLI parses typed inputs and defaults the site to the URL host", () => {
  const parsed = parseRunCliArgs(
    [
      "Add every mug under the limit",
      "--url",
      "https://shop.example.test/products",
      "--input-json",
      '{"query":"cup","unchanged":true}',
      "--input",
      "query=mug",
      "--input",
      "maxPrice=20",
      "--headless",
    ],
    "/project",
  );
  assert.equal(parsed.help, false);
  if (parsed.help) return;
  assert.deepEqual(parsed.options, {
    task: "Add every mug under the limit",
    startUrl: "https://shop.example.test/products",
    siteId: "shop.example.test",
    inputs: { query: "mug", unchanged: true, maxPrice: 20 },
    dataDirectory: resolve("/project/.mosaik"),
    headless: true,
    kernelStealth: false,
    kernelTimeoutSeconds: 300,
    json: false,
  });
});

test("run CLI accepts explicit IDs, model, and data directory", () => {
  const parsed = parseRunCliArgs(
    [
      "--task",
      "Search",
      "--url",
      "http://localhost:4317",
      "--site",
      "local-shop",
      "--automation-id",
      "search-1",
      "--model",
      "example/model",
      "--data-dir",
      "state",
      "--json",
    ],
    "/project",
  );
  assert.equal(parsed.help, false);
  if (parsed.help) return;
  assert.equal(parsed.options.siteId, "local-shop");
  assert.equal(parsed.options.automationId, "search-1");
  assert.equal(parsed.options.model, "example/model");
  assert.equal(parsed.options.dataDirectory, resolve("/project/state"));
  assert.equal(parsed.options.json, true);
});

test("run CLI accepts Kernel browser settings", () => {
  const parsed = parseRunCliArgs([
    "Search",
    "--url",
    "https://example.test",
    "--browser",
    "kernel",
    "--kernel-profile",
    "mosaik-test",
    "--kernel-stealth",
    "--kernel-timeout",
    "900",
  ]);
  assert.equal(parsed.help, false);
  if (parsed.help) return;
  assert.equal(parsed.options.browser, "kernel");
  assert.equal(parsed.options.kernelProfile, "mosaik-test");
  assert.equal(parsed.options.kernelStealth, true);
  assert.equal(parsed.options.kernelTimeoutSeconds, 900);
});

test("run CLI keeps an omitted browser unset and accepts an auth connection override", () => {
  const parsed = parseRunCliArgs([
    "Inspect",
    "--url",
    "https://example.test",
    "--kernel-auth-connection",
    "conn_123",
  ]);
  assert.equal(parsed.help, false);
  if (!parsed.help) {
    assert.equal(parsed.options.browser, undefined);
    assert.equal(parsed.options.kernelAuthConnection, "conn_123");
  }
  assert.throws(
    () =>
      parseRunCliArgs([
        "Inspect",
        "--url",
        "https://example.test",
        "--kernel-auth-connection",
        "conn_123",
        "--kernel-profile",
        "legacy",
      ]),
    /either --kernel-auth-connection or --kernel-profile/,
  );
});

test("run CLI help has no required arguments and invalid inputs fail early", () => {
  assert.deepEqual(parseRunCliArgs(["--help"]), { help: true });
  assert.throws(() => parseRunCliArgs([]), /task is required/);
  assert.throws(() => parseRunCliArgs(["Task", "--url", "file:///tmp/page"]), /http or https/);
  assert.throws(
    () => parseRunCliArgs(["Task", "--url", "https://example.test", "--input", "broken"]),
    /key=value/,
  );
  assert.throws(
    () => parseRunCliArgs(["Task", "--url", "https://example.test", "--input-json", "[]"]),
    /JSON object/,
  );
  assert.throws(
    () => parseRunCliArgs(["Task", "--url", "https://example.test", "--browser", "remote"]),
    /local.*kernel/,
  );
  assert.throws(
    () => parseRunCliArgs(["Task", "--url", "https://example.test", "--kernel-timeout", "9"]),
    /between 10 and 259200/,
  );
});

test("actions and doctor CLI options resolve data paths from the workspace", () => {
  const actions = parseActionsCliArgs(
    ["list", "--site", "example.test", "--data-dir", "state", "--json"],
    "/project",
  );
  assert.equal(actions.help, false);
  if (!actions.help) {
    assert.deepEqual(actions.options, {
      siteId: "example.test",
      dataDirectory: resolve("/project/state"),
      json: true,
    });
  }
  assert.deepEqual(parseDoctorCliArgs(["--data-dir", "state"], "/project"), {
    help: false,
    json: false,
    dataDirectory: resolve("/project/state"),
  });
  assert.equal(parseDoctorCliArgs(["--json"]).json, true);
});

test("kernel deploy defaults to the project env file and parses deployment options", () => {
  const defaults = parseKernelCliArgs(["deploy", "--version", "mosaik-test"], "/project");
  assert.equal(defaults.help, false);
  if (!defaults.help) {
    assert.deepEqual(defaults.options, {
      version: "mosaik-test",
      envFile: resolve("/project/.env"),
      force: false,
    });
  }
  const configured = parseKernelCliArgs(
    [
      "deploy",
      "--env-file",
      "config/kernel.env",
      "--namespace",
      "mosaik:staging",
      "--project",
      "demo",
      "--force",
    ],
    "/project",
  );
  assert.equal(configured.help, false);
  if (!configured.help) {
    assert.deepEqual(configured.options, {
      version: "latest",
      envFile: resolve("/project/config/kernel.env"),
      namespace: "mosaik:staging",
      project: "demo",
      force: true,
    });
  }
  assert.deepEqual(parseKernelCliArgs(["deploy", "--help"]), { help: true });
  assert.throws(() => parseKernelCliArgs([]), /deploy subcommand/);
  assert.throws(
    () => parseKernelCliArgs(["deploy", "--namespace", "spaces are invalid"]),
    /namespace/,
  );
});

test("pull CLI parses backend-agnostic synchronization options", () => {
  const parsed = parsePullCliArgs(
    [
      "--site",
      "example.com",
      "--env-file",
      "config/remote.env",
      "--namespace",
      "mosaik:test",
      "--dry-run",
      "--force",
      "--json",
    ],
    "/project",
  );
  assert.equal(parsed.help, false);
  if (!parsed.help) {
    assert.deepEqual(parsed.options, {
      siteId: "example.com",
      envFile: resolve("/project/config/remote.env"),
      namespace: "mosaik:test",
      dryRun: true,
      force: true,
      json: true,
    });
  }
  assert.deepEqual(parsePullCliArgs(["--help"]), { help: true });
  assert.throws(() => parsePullCliArgs(["--namespace", "invalid namespace"]), /namespace/);
});

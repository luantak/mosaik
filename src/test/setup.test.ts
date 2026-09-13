import assert from "node:assert/strict";
import { test } from "vitest";
import { browserBinaryStatuses, installBrowserBinaries } from "../setup.js";

test("Camoufox-only setup does not install Chromium", async () => {
  const calls: string[] = [];
  const result = await installBrowserBinaries("camoufox", {
    installChromium: async () => {
      calls.push("chromium");
      return 0;
    },
    installCamoufox: async () => {
      calls.push("camoufox");
      return 0;
    },
  });
  assert.deepEqual(calls, ["camoufox"]);
  assert.deepEqual(result, { camoufox: true });
});

test("all-browser setup attempts both installations and reports each result", async () => {
  const calls: string[] = [];
  const result = await installBrowserBinaries("all", {
    installChromium: async () => {
      calls.push("chromium");
      return 1;
    },
    installCamoufox: async () => {
      calls.push("camoufox");
      return 0;
    },
  });
  assert.deepEqual(calls, ["chromium", "camoufox"]);
  assert.deepEqual(result, { chromium: false, camoufox: true });
});

test("Chromium-only setup does not fetch Camoufox", async () => {
  const calls: string[] = [];
  const result = await installBrowserBinaries("chromium", {
    installChromium: async () => {
      calls.push("chromium");
      return 0;
    },
    installCamoufox: async () => {
      calls.push("camoufox");
      return 0;
    },
  });
  assert.deepEqual(calls, ["chromium"]);
  assert.deepEqual(result, { chromium: true });
});

test("doctor requires only the selected local browser", () => {
  assert.deepEqual(browserBinaryStatuses("camoufox", false, false), {
    chromium: "warn",
    camoufox: "fail",
  });
  assert.deepEqual(browserBinaryStatuses("local", false, false), {
    chromium: "fail",
    camoufox: "warn",
  });
  assert.deepEqual(browserBinaryStatuses("kernel", false, false), {
    chromium: "warn",
    camoufox: "warn",
  });
  assert.deepEqual(browserBinaryStatuses("camoufox", true, true), {
    chromium: "pass",
    camoufox: "pass",
  });
});

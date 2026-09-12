import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CAMOUFOX_LAUNCH_OPTION_MAPPING,
  defaultCamoufoxOptions,
  hostCamoufoxOs,
  resolveCamoufoxOptions,
  toCamoufoxLaunchOptions,
  validateCamoufoxOptions,
} from "../options.js";

test("default Camoufox options pin the host OS and leave native humanization off", () => {
  const defaults = defaultCamoufoxOptions();
  assert.equal(defaults.os, hostCamoufoxOs());
  assert.equal(defaults.humanize, false);
  assert.equal(defaults.geoip, false);
  assert.equal(defaults.blockImages, false);
  assert.equal(defaults.blockWebRtc, false);
  assert.equal(toCamoufoxLaunchOptions({}).humanize, false);
});

test("mosaik-owned Camoufox options map onto camoufox-js LaunchOptions", () => {
  assert.deepEqual(CAMOUFOX_LAUNCH_OPTION_MAPPING, {
    os: "os",
    locale: "locale",
    geoip: "geoip",
    humanize: "humanize",
    window: "window",
    screen: "screen",
    blockImages: "block_images",
    blockWebRtc: "block_webrtc",
    headless: "headless",
    profileDirectory: "user_data_dir",
  });
  assert.deepEqual(
    toCamoufoxLaunchOptions(
      {
        os: "windows",
        locale: ["en-US", "en"],
        geoip: "203.0.113.10",
        humanize: 1.5,
        window: [1280, 800],
        screen: { maxWidth: 1920, maxHeight: 1080 },
        blockImages: true,
        blockWebRtc: true,
      },
      { headless: true, userDataDir: "/tmp/camoufox-profile" },
    ),
    {
      os: "windows",
      locale: ["en-US", "en"],
      geoip: "203.0.113.10",
      humanize: 1.5,
      window: [1280, 800],
      screen: { maxWidth: 1920, maxHeight: 1080 },
      block_images: true,
      block_webrtc: true,
      headless: true,
      user_data_dir: "/tmp/camoufox-profile",
    },
  );
});

test("resolveCamoufoxOptions fills only the mosaik-owned defaults", () => {
  assert.deepEqual(resolveCamoufoxOptions({ locale: "de-DE" }), {
    ...defaultCamoufoxOptions(),
    locale: "de-DE",
  });
  assert.equal(resolveCamoufoxOptions({}).humanize, false);
  assert.equal(resolveCamoufoxOptions({ humanize: true }).humanize, true);
  assert.equal(resolveCamoufoxOptions({ humanize: 1.5 }).humanize, 1.5);
});

test("validateCamoufoxOptions rejects unknown keys and invalid values", () => {
  assert.deepEqual(validateCamoufoxOptions({ os: ["linux", "windows"], humanize: false }), {
    os: ["linux", "windows"],
    humanize: false,
  });
  assert.throws(() => validateCamoufoxOptions({ fingerprint: {} }), /not a supported/);
  assert.throws(() => validateCamoufoxOptions({ os: "android" }), /windows, macos, or linux/);
  assert.throws(() => validateCamoufoxOptions({ humanize: 0 }), /positive number/);
  assert.throws(() => validateCamoufoxOptions({ window: [0, 800] }), /positive integers/);
});

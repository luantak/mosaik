export const CAMOUFOX_OS_VALUES = ["windows", "macos", "linux"] as const;

export type CamoufoxOs = (typeof CAMOUFOX_OS_VALUES)[number];

export interface CamoufoxScreenConstraints {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

/** Mosaik-owned Camoufox fingerprint and native humanization options. */
export interface CamoufoxOptions {
  /** OS used for fingerprint generation. Defaults to the host OS. */
  os?: CamoufoxOs | CamoufoxOs[];
  /** Locale(s). The first listed locale is used for the Intl API. */
  locale?: string | string[];
  /**
   * Derive timezone, locale, and geolocation from an IP address.
   * `true` auto-detects the current IP. Default is `false` so launch stays offline.
   */
  geoip?: boolean | string;
  /**
   * Optional Camoufox-native cursor humanization. This is not mosaik `--humanize`.
   * `true` enables the default motion, or pass the maximum cursor travel time in seconds.
   * Default is `false`.
   */
  humanize?: boolean | number;
  /** Fixed window size `[width, height]`. Omit to let Camoufox sample one. */
  window?: readonly [number, number];
  /** Constrains the generated fingerprint's screen size. */
  screen?: CamoufoxScreenConstraints;
  /** Block image requests. Default is `false`. */
  blockImages?: boolean;
  /** Block WebRTC. Default is `false`. */
  blockWebRtc?: boolean;
}

export interface ResolvedCamoufoxOptions {
  os: CamoufoxOs | CamoufoxOs[];
  humanize: boolean | number;
  geoip: boolean | string;
  blockImages: boolean;
  blockWebRtc: boolean;
  locale?: string | string[];
  window?: readonly [number, number];
  screen?: CamoufoxScreenConstraints;
}

/** Fields passed to camoufox-js `LaunchOptions`. */
export interface CamoufoxLaunchOptions {
  os: CamoufoxOs | CamoufoxOs[];
  humanize: boolean | number;
  geoip: boolean | string;
  block_images: boolean;
  block_webrtc: boolean;
  locale?: string | string[];
  window?: [number, number];
  screen?: CamoufoxScreenConstraints;
  headless?: boolean;
  user_data_dir?: string;
}

export const CAMOUFOX_LAUNCH_OPTION_MAPPING = {
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
} as const;

export function hostCamoufoxOs(): CamoufoxOs {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

export function defaultCamoufoxOptions(): ResolvedCamoufoxOptions {
  return {
    os: hostCamoufoxOs(),
    humanize: false,
    geoip: false,
    blockImages: false,
    blockWebRtc: false,
  };
}

export function resolveCamoufoxOptions(options: CamoufoxOptions = {}): ResolvedCamoufoxOptions {
  const defaults = defaultCamoufoxOptions();
  const os = options.os === undefined ? defaults.os : validateOs(options.os);
  const humanize =
    options.humanize === undefined ? defaults.humanize : validateHumanize(options.humanize);
  const geoip = options.geoip === undefined ? defaults.geoip : validateGeoip(options.geoip);
  const locale = options.locale === undefined ? undefined : validateLocale(options.locale);
  const window = options.window === undefined ? undefined : validateWindow(options.window);
  const screen = options.screen === undefined ? undefined : validateScreen(options.screen);
  return {
    os,
    humanize,
    geoip,
    blockImages: options.blockImages ?? defaults.blockImages,
    blockWebRtc: options.blockWebRtc ?? defaults.blockWebRtc,
    ...(locale === undefined ? {} : { locale }),
    ...(window === undefined ? {} : { window }),
    ...(screen === undefined ? {} : { screen }),
  };
}

export function toCamoufoxLaunchOptions(
  options: CamoufoxOptions = {},
  launch: { headless?: boolean; userDataDir?: string } = {},
): CamoufoxLaunchOptions {
  const resolved = resolveCamoufoxOptions(options);
  return {
    os: resolved.os,
    humanize: resolved.humanize,
    geoip: resolved.geoip,
    block_images: resolved.blockImages,
    block_webrtc: resolved.blockWebRtc,
    ...(resolved.locale === undefined ? {} : { locale: resolved.locale }),
    ...(resolved.window === undefined ? {} : { window: [resolved.window[0], resolved.window[1]] }),
    ...(resolved.screen === undefined ? {} : { screen: resolved.screen }),
    ...(launch.headless === undefined ? {} : { headless: launch.headless }),
    ...(launch.userDataDir === undefined ? {} : { user_data_dir: launch.userDataDir }),
  };
}

export function validateCamoufoxOptions(value: unknown, label = "camoufox"): CamoufoxOptions {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const known = [
    "os",
    "locale",
    "geoip",
    "humanize",
    "window",
    "screen",
    "blockImages",
    "blockWebRtc",
  ];
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) throw new Error(`${label}.${key} is not a supported Camoufox option`);
  }
  const os = record.os === undefined ? undefined : validateOs(record.os, `${label}.os`);
  const locale =
    record.locale === undefined ? undefined : validateLocale(record.locale, `${label}.locale`);
  const geoip =
    record.geoip === undefined ? undefined : validateGeoip(record.geoip, `${label}.geoip`);
  const humanize =
    record.humanize === undefined
      ? undefined
      : validateHumanize(record.humanize, `${label}.humanize`);
  const window =
    record.window === undefined ? undefined : validateWindow(record.window, `${label}.window`);
  const screen =
    record.screen === undefined ? undefined : validateScreen(record.screen, `${label}.screen`);
  const blockImages = optionalBoolean(record.blockImages, `${label}.blockImages`);
  const blockWebRtc = optionalBoolean(record.blockWebRtc, `${label}.blockWebRtc`);
  return {
    ...(os === undefined ? {} : { os }),
    ...(locale === undefined ? {} : { locale }),
    ...(geoip === undefined ? {} : { geoip }),
    ...(humanize === undefined ? {} : { humanize }),
    ...(window === undefined ? {} : { window }),
    ...(screen === undefined ? {} : { screen }),
    ...(blockImages === undefined ? {} : { blockImages }),
    ...(blockWebRtc === undefined ? {} : { blockWebRtc }),
  };
}

function validateOs(value: unknown, label = "os"): CamoufoxOs | CamoufoxOs[] {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error(`${label} must not be empty`);
    return value.map((entry, index) => {
      const os = validateOs(entry, `${label}[${index}]`);
      if (Array.isArray(os)) throw new Error(`${label}[${index}] must be windows, macos, or linux`);
      return os;
    });
  }
  if (value !== "windows" && value !== "macos" && value !== "linux") {
    throw new Error(`${label} must be windows, macos, or linux`);
  }
  return value;
}

function validateLocale(value: unknown, label = "locale"): string | string[] {
  if (typeof value === "string") {
    const locale = value.trim();
    if (locale.length === 0) throw new Error(`${label} is required`);
    return locale;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a locale string or a non-empty array of locale strings`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${label}[${index}] must be a locale string`);
    }
    return entry.trim();
  });
}

function validateGeoip(value: unknown, label = "geoip"): boolean | string {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const geoip = value.trim();
    if (geoip.length === 0) throw new Error(`${label} is required`);
    return geoip;
  }
  throw new Error(`${label} must be a boolean or IP address`);
}

function validateHumanize(value: unknown, label = "humanize"): boolean | number {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  throw new Error(`${label} must be a boolean or a positive number of seconds`);
}

function validateWindow(value: unknown, label = "window"): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${label} must be [width, height]`);
  }
  const width = value[0];
  const height = value[1];
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new Error(`${label} must be positive integers`);
  }
  return [width, height];
}

function validateScreen(value: unknown, label = "screen"): CamoufoxScreenConstraints {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const screen: CamoufoxScreenConstraints = {
    ...(record.minWidth === undefined
      ? {}
      : { minWidth: positiveInteger(record.minWidth, `${label}.minWidth`) }),
    ...(record.maxWidth === undefined
      ? {}
      : { maxWidth: positiveInteger(record.maxWidth, `${label}.maxWidth`) }),
    ...(record.minHeight === undefined
      ? {}
      : { minHeight: positiveInteger(record.minHeight, `${label}.minHeight`) }),
    ...(record.maxHeight === undefined
      ? {}
      : { maxHeight: positiveInteger(record.maxHeight, `${label}.maxHeight`) }),
  };
  return screen;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

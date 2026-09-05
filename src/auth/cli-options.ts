import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { localBrowserProfileDirectory } from "./profile.js";

export interface LoginCliOptions {
  loginUrl: string;
  dataDirectory: string;
  profileDirectory: string;
  headless: boolean;
  browser?: "local" | "kernel";
  kernelProfile?: string;
  domain?: string;
  allowedDomains?: string[];
  noOpen?: boolean;
  noWait?: boolean;
  json?: boolean;
  pause: boolean;
  timeoutMs: number;
  maxSteps: number;
  checkUrl?: string;
}

export type LoginCliParseResult = { help: true } | { help: false; options: LoginCliOptions };

export const LOGIN_CLI_HELP = `Usage:
  mosaik login <login-url> [options]
  mosaik login --url <login-url> [options]

Options:
  -u, --url <url>                Login page URL
      --data-dir <directory>     Mosaik data directory, default .mosaik
      --browser <local|kernel>    Browser provider
      --kernel-profile <name>     Kernel profile name override
      --domain <domain>           Kernel target domain, default login URL host
      --allowed-domain <domain>   Extra Kernel identity-provider domain, repeatable
      --no-open                   Print the hosted URL without opening it
      --no-wait                   Start hosted login and exit
      --json                      Print one machine-readable start result
  -p, --profile <directory>      Browser profile and raw credential directory
      --check-url <url>          Override the inferred verification page
      --timeout-ms <number>      Per-page timeout, default 10000
      --max-steps <number>       Maximum login pages, default 5
      --headless                 Hide the browser window
      --pause                    Keep the verification page open until Enter
  -h, --help                     Show this help

Example:
  mosaik login http://localhost:3000/login \\
    --pause

Security:
  Usernames and passwords are saved unencrypted inside the profile directory.
  One-time codes are not saved.
`;

export function parseLoginCliArgs(
  args: string[],
  workingDirectory = process.cwd(),
): LoginCliParseResult {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const parsed = parseArgs({
    args: normalizedArgs,
    allowPositionals: true,
    strict: true,
    options: {
      url: { type: "string", short: "u" },
      "data-dir": { type: "string" },
      profile: { type: "string", short: "p" },
      browser: { type: "string" },
      "kernel-profile": { type: "string" },
      domain: { type: "string" },
      "allowed-domain": { type: "string", multiple: true },
      "no-open": { type: "boolean", default: false },
      "no-wait": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "check-url": { type: "string" },
      "timeout-ms": { type: "string" },
      "max-steps": { type: "string" },
      headless: { type: "boolean", default: false },
      pause: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.values.help) return { help: true };
  if (parsed.positionals.length > 1) throw new Error("Pass only one login URL");
  const positionalUrl = parsed.positionals[0];
  const flagUrl = parsed.values.url;
  if (positionalUrl !== undefined && flagUrl !== undefined && positionalUrl !== flagUrl) {
    throw new Error("Pass the login URL once, either as a positional value or with --url");
  }
  const loginUrl = flagUrl ?? positionalUrl;
  if (loginUrl === undefined) throw new Error("A login URL is required");
  const parsedLoginUrl = webUrl(loginUrl, "login URL");
  const browser = parsed.values.browser;
  if (browser !== undefined && browser !== "local" && browser !== "kernel") {
    throw new Error('--browser must be "local" or "kernel"');
  }
  if (parsed.values["kernel-profile"] !== undefined && browser === "local") {
    throw new Error("--kernel-profile requires --browser kernel");
  }
  if (parsed.values.profile !== undefined && browser === "kernel") {
    throw new Error("--profile is only available with --browser local");
  }
  if (parsed.values["check-url"] !== undefined && browser === "kernel") {
    throw new Error("--check-url is only available with --browser local");
  }
  if (
    (parsed.values["timeout-ms"] !== undefined ||
      parsed.values["max-steps"] !== undefined ||
      parsed.values.pause ||
      parsed.values.headless) &&
    browser === "kernel"
  ) {
    throw new Error("Kernel hosted login does not accept local browser options");
  }
  const checkUrl = optionalWebUrl(parsed.values["check-url"], "check URL");
  const timeoutMs = positiveInteger(parsed.values["timeout-ms"] ?? "10000", "timeout-ms");
  const maxSteps = positiveInteger(parsed.values["max-steps"] ?? "5", "max-steps");
  const dataDirectory = resolve(workingDirectory, parsed.values["data-dir"] ?? ".mosaik");
  const profileDirectory =
    parsed.values.profile === undefined
      ? localBrowserProfileDirectory(dataDirectory, parsedLoginUrl.href)
      : resolve(workingDirectory, parsed.values.profile);
  return {
    help: false,
    options: {
      loginUrl: parsedLoginUrl.href,
      dataDirectory,
      profileDirectory,
      headless: parsed.values.headless,
      ...(browser === undefined ? {} : { browser }),
      ...(parsed.values["kernel-profile"] === undefined
        ? {}
        : { kernelProfile: parsed.values["kernel-profile"] }),
      ...(parsed.values.domain === undefined ? {} : { domain: parsed.values.domain }),
      ...(parsed.values["allowed-domain"] === undefined
        ? {}
        : { allowedDomains: parsed.values["allowed-domain"] }),
      ...(parsed.values["no-open"] ? { noOpen: true } : {}),
      ...(parsed.values["no-wait"] ? { noWait: true } : {}),
      ...(parsed.values.json ? { json: true } : {}),
      pause: parsed.values.pause,
      timeoutMs,
      maxSteps,
      ...(checkUrl === undefined ? {} : { checkUrl: checkUrl.href }),
    },
  };
}

function webUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`The ${label} is not valid: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`The ${label} must use http or https`);
  }
  return parsed;
}

function optionalWebUrl(value: string | undefined, label: string): URL | undefined {
  return value === undefined ? undefined : webUrl(value, label);
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`--${label} must be a positive integer`);
  }
  return parsed;
}

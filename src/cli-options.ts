import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultPackageName } from "./init.js";

export interface RunCliOptions {
  task: string;
  startUrl: string;
  siteId: string;
  inputs: Record<string, unknown>;
  dataDirectory: string;
  headless: boolean;
  humanize?: boolean;
  browser?: "local" | "kernel";
  kernelStealth: boolean;
  kernelTimeoutSeconds: number;
  kernelProfile?: string;
  kernelAuthConnection?: string;
  json: boolean;
  model?: string;
  automationId?: string;
}

export type RunCliParseResult = { help: true } | { help: false; options: RunCliOptions };

export const RUN_CLI_HELP = `Compose a task from learned actions, discover one missing action when needed,
and run the resulting browser automation.

Usage:
  mosaik run <task> --url <url> [options]
  mosaik run --task <task> --url <url> [options]

Options:
  -t, --task <task>             Browser task
  -u, --url <url>               Starting page URL
      --site <site-id>          Capability site ID, default URL host
  -i, --input <key=value>       Input value, repeatable
      --input-json <object>     Input values as a JSON object
      --automation-id <id>      Stable ID for the generated automation
      --data-dir <directory>    Mosaik data directory, default .mosaik
      --model <model>           Composition and discovery model
      --browser <provider>      Browser provider: local or kernel
      --kernel-profile <name>   Kernel profile name to load and save
      --kernel-auth-connection <id>
                                 Authenticated Kernel connection to load
      --kernel-stealth          Enable Kernel stealth mode and CAPTCHA solving
      --kernel-timeout <secs>   Kernel inactivity timeout, default 300
      --headless                Hide the browser window
      --humanize                Use human-like interaction timing and mouse movement
      --no-humanize             Disable a configured humanization default
      --json                    Print the complete result as JSON
  -h, --help                    Show this help

Examples:
  mosaik run "Search for ceramic mugs" --url https://example.com \\
    --input query=mug

  mosaik run "Add every mug under 20 euros to the cart" \\
    --url https://example.com --input query=mug --input maxPrice=20
`;

export function parseRunCliArgs(
  args: string[],
  workingDirectory = process.cwd(),
): RunCliParseResult {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      task: { type: "string", short: "t" },
      url: { type: "string", short: "u" },
      site: { type: "string" },
      input: { type: "string", short: "i", multiple: true },
      "input-json": { type: "string" },
      "automation-id": { type: "string" },
      "data-dir": { type: "string" },
      model: { type: "string" },
      browser: { type: "string" },
      "kernel-profile": { type: "string" },
      "kernel-auth-connection": { type: "string" },
      "kernel-stealth": { type: "boolean", default: false },
      "kernel-timeout": { type: "string", default: "300" },
      headless: { type: "boolean", default: false },
      humanize: { type: "boolean" },
      "no-humanize": { type: "boolean" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.values.help) return { help: true };
  if (parsed.values.humanize && parsed.values["no-humanize"]) {
    throw new Error("Pass either --humanize or --no-humanize, not both");
  }
  if (parsed.positionals.length > 1) throw new Error("Pass the task as one quoted argument");
  const positionalTask = parsed.positionals[0];
  const flagTask = parsed.values.task;
  if (positionalTask !== undefined && flagTask !== undefined && positionalTask !== flagTask) {
    throw new Error("Pass the task once, either as a positional value or with --task");
  }
  const task = (flagTask ?? positionalTask)?.trim();
  if (task === undefined || task.length === 0) throw new Error("A task is required");
  if (parsed.values.url === undefined) throw new Error("--url is required");
  const startUrl = parseWebUrl(parsed.values.url, "start URL");
  const siteId = parsed.values.site?.trim() || startUrl.host;
  const browser = parsed.values.browser;
  if (browser !== "local" && browser !== "kernel") {
    if (browser !== undefined) throw new Error('--browser must be "local" or "kernel"');
  }
  if (
    parsed.values["kernel-auth-connection"] !== undefined &&
    parsed.values["kernel-profile"] !== undefined
  ) {
    throw new Error("Pass either --kernel-auth-connection or --kernel-profile, not both");
  }
  const kernelTimeoutSeconds = Number(parsed.values["kernel-timeout"]);
  if (
    !Number.isSafeInteger(kernelTimeoutSeconds) ||
    kernelTimeoutSeconds < 10 ||
    kernelTimeoutSeconds > 259_200
  ) {
    throw new Error("--kernel-timeout must be an integer between 10 and 259200");
  }
  const inputs = parseInputObject(parsed.values["input-json"]);
  for (const assignment of parsed.values.input ?? []) {
    const separator = assignment.indexOf("=");
    if (separator < 1) throw new Error(`--input must use key=value: ${assignment}`);
    const key = assignment.slice(0, separator).trim();
    if (key.length === 0) throw new Error(`--input has an empty key: ${assignment}`);
    inputs[key] = parseInputValue(assignment.slice(separator + 1));
  }
  return {
    help: false,
    options: {
      task,
      startUrl: startUrl.href,
      siteId,
      inputs,
      dataDirectory: resolve(workingDirectory, parsed.values["data-dir"] ?? ".mosaik"),
      headless: parsed.values.headless,
      ...(parsed.values.humanize
        ? { humanize: true }
        : parsed.values["no-humanize"]
          ? { humanize: false }
          : {}),
      ...(browser === undefined ? {} : { browser }),
      kernelStealth: parsed.values["kernel-stealth"],
      kernelTimeoutSeconds,
      json: parsed.values.json,
      ...(parsed.values["kernel-auth-connection"] === undefined
        ? {}
        : { kernelAuthConnection: parsed.values["kernel-auth-connection"] }),
      ...(parsed.values["kernel-profile"] === undefined
        ? {}
        : { kernelProfile: parsed.values["kernel-profile"] }),
      ...(parsed.values.model === undefined ? {} : { model: parsed.values.model }),
      ...(parsed.values["automation-id"] === undefined
        ? {}
        : { automationId: parsed.values["automation-id"] }),
    },
  };
}

export type ConfigCliOptions =
  | { dataDirectory: string; setting: "browser"; value: "local" | "kernel" }
  | { dataDirectory: string; setting: "humanize"; value: boolean };

export type ConfigCliParseResult = { help: true } | { help: false; options: ConfigCliOptions };

export const CONFIG_CLI_HELP = `Set project-local Mosaik defaults.

Usage:
  mosaik config set browser <local|kernel> [options]
  mosaik config set humanize <true|false> [options]

Options:
      --data-dir <directory>    Mosaik data directory, default .mosaik
  -h, --help                    Show this help
`;

export function parseConfigCliArgs(
  args: string[],
  workingDirectory = process.cwd(),
): ConfigCliParseResult {
  const [subcommand, setting, value, ...rest] = args;
  if (subcommand === "--help" || subcommand === "-h") return { help: true };
  if (
    subcommand !== "set" ||
    (setting !== "browser" && setting !== "humanize") ||
    value === undefined
  ) {
    throw new Error("Usage: mosaik config set <browser|humanize> <value>");
  }
  const parsed = parseArgs({
    args: rest,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.values.help) return { help: true };
  const dataDirectory = resolve(workingDirectory, parsed.values["data-dir"] ?? ".mosaik");
  if (setting === "humanize") {
    if (value !== "true" && value !== "false") {
      throw new Error("humanize must be true or false");
    }
    return { help: false, options: { setting, value: value === "true", dataDirectory } };
  }
  if (value !== "local" && value !== "kernel") {
    throw new Error('browser must be "local" or "kernel"');
  }
  return { help: false, options: { setting, value, dataDirectory } };
}

export interface ActionsCliOptions {
  dataDirectory: string;
  json: boolean;
  siteId?: string;
}

export type ActionsCliParseResult = { help: true } | { help: false; options: ActionsCliOptions };

export const ACTIONS_CLI_HELP = `Inspect reusable actions learned for each site.

Usage:
  mosaik actions list [options]

Options:
      --site <site-id>          Show actions for one site
      --data-dir <directory>    Mosaik data directory, default .mosaik
      --json                    Print JSON
  -h, --help                    Show this help
`;

export function parseActionsCliArgs(
  args: string[],
  workingDirectory = process.cwd(),
): ActionsCliParseResult {
  const [subcommand, ...rest] = args;
  if (subcommand === "--help" || subcommand === "-h") return { help: true };
  if (subcommand !== "list") throw new Error("The actions command requires the list subcommand");
  const parsed = parseArgs({
    args: rest,
    strict: true,
    options: {
      site: { type: "string" },
      "data-dir": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.values.help) return { help: true };
  return {
    help: false,
    options: {
      dataDirectory: resolve(workingDirectory, parsed.values["data-dir"] ?? ".mosaik"),
      json: parsed.values.json,
      ...(parsed.values.site === undefined ? {} : { siteId: parsed.values.site }),
    },
  };
}

export interface DoctorCliOptions {
  help: boolean;
  json: boolean;
  dataDirectory: string;
}

export const DOCTOR_CLI_HELP = `Check Node.js, the global command, DSH, bundled assets, Chromium,
provider credentials, and the data directory.

Usage:
  mosaik doctor [options]

Options:
      --data-dir <directory>    Mosaik data directory, default .mosaik
      --json                    Print machine-readable diagnostics
  -h, --help                    Show this help
`;

export function parseDoctorCliArgs(
  args: string[],
  workingDirectory = process.cwd(),
): DoctorCliOptions {
  const parsed = parseArgs({
    args,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return {
    help: parsed.values.help,
    json: parsed.values.json,
    dataDirectory: resolve(workingDirectory, parsed.values["data-dir"] ?? ".mosaik"),
  };
}

export interface InitCliOptions {
  directory: string;
  name: string;
  force: boolean;
}

export type InitCliParseResult = { help: true } | { help: false; options: InitCliOptions };

export const INIT_CLI_HELP = `Create a pnpm TypeScript project that can import mosaik/actions and
mosaik/automations with full type resolution.

Usage:
  mosaik init [directory] [options]

Options:
      --name <name>             Package name, default directory basename
      --force                   Overwrite existing scaffold files
  -h, --help                    Show this help

Examples:
  mosaik init
  mosaik init ./my-bot --name my-bot
`;

export function parseInitCliArgs(
  args: string[],
  workingDirectory = process.cwd(),
): InitCliParseResult {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      name: { type: "string" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.values.help) return { help: true };
  if (parsed.positionals.length > 1) {
    throw new Error("Pass at most one directory to mosaik init");
  }
  const directory = resolve(workingDirectory, parsed.positionals[0] ?? ".");
  const name = parsed.values.name?.trim() || defaultPackageName(directory);
  return {
    help: false,
    options: {
      directory,
      name,
      force: parsed.values.force,
    },
  };
}

export interface KernelDeployCliOptions {
  version: string;
  envFile: string;
  namespace?: string;
  force: boolean;
  project?: string;
}

export type KernelCliParseResult =
  | { help: true }
  | { help: false; options: KernelDeployCliOptions };

export const KERNEL_CLI_HELP = `Deploy this project's learned site library as a Kernel app.

Usage:
  mosaik kernel deploy [options]

Options:
      --version <version>      Deployment version, default latest
      --env-file <path>       Kernel environment file, default .env
      --namespace <name>      Redis namespace, default mosaik:<package-name>
      --project <project>     Kernel project ID or name
      --force                 Replace an existing deployment version
  -h, --help                  Show this help

Example:
  mosaik kernel deploy --version mosaik-test
`;

export function parseKernelCliArgs(
  args: string[],
  workingDirectory = process.cwd(),
): KernelCliParseResult {
  const [subcommand, ...rest] = args;
  if (subcommand === "--help" || subcommand === "-h") return { help: true };
  if (subcommand !== "deploy") throw new Error("The kernel command requires the deploy subcommand");
  const parsed = parseArgs({
    args: rest,
    strict: true,
    options: {
      version: { type: "string", default: "latest" },
      "env-file": { type: "string", default: ".env" },
      namespace: { type: "string" },
      project: { type: "string" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.values.help) return { help: true };
  const version = parsed.values.version.trim();
  if (version.length === 0) throw new Error("--version cannot be empty");
  const namespace = parsed.values.namespace?.trim();
  if (namespace !== undefined && !/^[A-Za-z0-9:_-]+$/.test(namespace)) {
    throw new Error("--namespace may contain letters, numbers, colons, dashes, and underscores");
  }
  const project = parsed.values.project?.trim();
  return {
    help: false,
    options: {
      version,
      envFile: resolve(workingDirectory, parsed.values["env-file"]),
      force: parsed.values.force,
      ...(namespace === undefined ? {} : { namespace }),
      ...(project === undefined || project.length === 0 ? {} : { project }),
    },
  };
}

export interface PullCliOptions {
  envFile: string;
  dryRun: boolean;
  force: boolean;
  json: boolean;
  namespace?: string;
  siteId?: string;
}

export type PullCliParseResult = { help: true } | { help: false; options: PullCliOptions };

export const PULL_CLI_HELP = `Pull learned actions and automations from the configured remote library.

Usage:
  mosaik pull [options]

Options:
      --site <site-id>        Pull one site only
      --env-file <path>       Environment file, default .env
      --namespace <name>      Remote-library namespace
      --dry-run               Show changes without writing files
      --force                 Replace conflicting local records
      --json                  Print JSON
  -h, --help                  Show this help

The command writes only canonical sites/<site>/actions and automations files.
`;

export function parsePullCliArgs(
  args: string[],
  workingDirectory = process.cwd(),
): PullCliParseResult {
  const parsed = parseArgs({
    args,
    strict: true,
    options: {
      site: { type: "string" },
      "env-file": { type: "string", default: ".env" },
      namespace: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.values.help) return { help: true };
  const namespace = parsed.values.namespace?.trim();
  if (namespace !== undefined && !/^[A-Za-z0-9:_-]+$/.test(namespace)) {
    throw new Error("--namespace may contain letters, numbers, colons, dashes, and underscores");
  }
  const siteId = parsed.values.site?.trim();
  if (siteId !== undefined && siteId.length === 0) throw new Error("--site cannot be empty");
  return {
    help: false,
    options: {
      envFile: resolve(workingDirectory, parsed.values["env-file"]),
      dryRun: parsed.values["dry-run"],
      force: parsed.values.force,
      json: parsed.values.json,
      ...(namespace === undefined ? {} : { namespace }),
      ...(siteId === undefined ? {} : { siteId }),
    },
  };
}

function parseWebUrl(value: string, label: string): URL {
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

function parseInputObject(value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--input-json must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--input-json must contain a JSON object");
  }
  return { ...(parsed as Record<string, unknown>) };
}

function parseInputValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

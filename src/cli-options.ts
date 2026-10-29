import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveLlmRoute } from "./agents/dsh/llm-route.js";
import { isBrowserProvider, type BrowserProvider } from "./config.js";
import { defaultPackageName } from "./init.js";

export interface RunCliOptions {
  task: string;
  startUrl: string;
  siteId: string;
  inputs: Record<string, unknown>;
  dataDirectory: string;
  headless: boolean;
  humanize?: boolean;
  browser?: BrowserProvider;
  kernelStealth: boolean;
  kernelTimeoutSeconds: number;
  kernelProfile?: string;
  kernelAuthConnection?: string;
  json: boolean;
  model?: string;
  automationId?: string;
}

export type RunCliParseResult = { help: true } | { help: false; options: RunCliOptions };

export interface InteractiveCliOptions {
  model?: string;
}

export type InteractiveCliParseResult =
  | { help: true }
  | { help: false; options: InteractiveCliOptions };

export const INTERACTIVE_CLI_HELP = `Start an interactive browser session.

Usage:
  mosaik [options]

Options:
      --model <model>           Composition and discovery model.
                                Use gpt-5.6-luna after mosaik provider login.
                                Codex models use Fast mode by default.
  -h, --help                    Show this help
`;

export function parseInteractiveCliArgs(args: string[]): InteractiveCliParseResult {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      model: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.values.help) return { help: true };
  if (parsed.positionals.length > 0) {
    throw new Error(`Unknown argument "${parsed.positionals[0]}"`);
  }
  if (parsed.values.model !== undefined) {
    const model = parsed.values.model.trim();
    resolveLlmRoute(model);
    return { help: false, options: { model } };
  }
  return { help: false, options: {} };
}

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
      --model <model>           Composition and discovery model.
                                Use gpt-5.6-luna after mosaik provider login.
                                Codex models use Fast mode by default.
      --browser <provider>      Browser provider: local, camoufox, or kernel
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
  if (browser !== undefined && !isBrowserProvider(browser)) {
    throw new Error('--browser must be "local", "camoufox", or "kernel"');
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
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`Unsafe input key: ${key}`);
    }
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

export interface ExecuteCliOptions extends Omit<
  RunCliOptions,
  "task" | "startUrl" | "model" | "automationId"
> {
  automationId: string;
  startUrl?: string;
  timeoutMs: number;
  maxActionCalls: number;
  outputDirectory?: string;
  jobDirectory?: string;
}

export const EXECUTE_CLI_HELP = `Execute a saved automation with new inputs, without composition or model calls.

Usage:
  mosaik execute <id> --site <site-id> [options]

Options:
      --site <site-id>          Site containing the saved automation (required)
  -i, --input <key=value>       Typed input value, repeatable
      --input-json <object>     Input values as a JSON object
  -u, --url <url>               Override the saved starting URL
      --data-dir <directory>    Mosaik data directory, default .mosaik
      --output-dir <directory>  Output directory, default .mosaik/runs/<id>/output
      --job-dir <directory>     Durable job directory for a batch extraction
      --timeout <ms>            Runtime timeout, default 180000
      --max-action-calls <n>    Runtime action limit, default 1000
      --browser <provider>      local, camoufox, or kernel
      --kernel-profile <name>   Kernel profile name to load and save
      --kernel-auth-connection <id>  Authenticated Kernel connection to load
      --kernel-stealth          Enable Kernel stealth mode
      --kernel-timeout <secs>   Kernel inactivity timeout, default 300
      --headless                Hide the browser window
      --humanize                Use human-like interactions
      --no-humanize             Disable configured humanization
      --json                    Print the full execution report as JSON
  -h, --help                    Show this help

Execution success is separate from task completion. External side effects are refused.
Exit codes: 0 complete, 2 incomplete/unverified, 1 failed, 130 interrupted.
`;

export function parseExecuteCliArgs(
  args: string[],
  workingDirectory = process.cwd(),
): { help: true } | { help: false; options: ExecuteCliOptions } {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      site: { type: "string" },
      url: { type: "string", short: "u" },
      input: { type: "string", short: "i", multiple: true },
      "input-json": { type: "string" },
      "data-dir": { type: "string" },
      "output-dir": { type: "string" },
      "job-dir": { type: "string" },
      timeout: { type: "string", default: "180000" },
      "max-action-calls": { type: "string", default: "1000" },
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
  if (parsed.positionals.length !== 1 || !parsed.positionals[0]?.trim())
    throw new Error("Pass one saved automation ID");
  if (!parsed.values.site?.trim()) throw new Error("--site is required");
  const common = [
    "saved execution",
    "--url",
    parsed.values.url ?? "https://unused.invalid",
    "--site",
    parsed.values.site,
  ];
  for (const [key, value] of Object.entries(parsed.values)) {
    if (
      ["site", "url", "timeout", "max-action-calls", "output-dir", "job-dir", "help"].includes(
        key,
      ) ||
      value === undefined ||
      value === false
    )
      continue;
    if (value === true) common.push(`--${key}`);
    else if (Array.isArray(value)) for (const item of value) common.push(`--${key}`, item);
    else common.push(`--${key}`, value);
  }
  const base = parseRunCliArgs(common, workingDirectory);
  if (base.help) throw new Error("Unexpected execution help");
  const {
    task: _task,
    startUrl: _startUrl,
    model: _model,
    automationId: _id,
    ...shared
  } = base.options;
  const timeoutMs = positiveInteger(parsed.values.timeout, "--timeout");
  const maxActionCalls = positiveInteger(parsed.values["max-action-calls"], "--max-action-calls");
  return {
    help: false,
    options: {
      ...shared,
      automationId: parsed.positionals[0],
      timeoutMs,
      maxActionCalls,
      ...(parsed.values.url === undefined ? {} : { startUrl: _startUrl }),
      ...(parsed.values["output-dir"] === undefined
        ? {}
        : { outputDirectory: resolve(workingDirectory, parsed.values["output-dir"]) }),
      ...(parsed.values["job-dir"] === undefined
        ? {}
        : { jobDirectory: resolve(workingDirectory, parsed.values["job-dir"]) }),
    },
  };
}

export type ResumeCliOptions = Omit<
  ExecuteCliOptions,
  "automationId" | "siteId" | "inputs" | "startUrl" | "jobDirectory" | "outputDirectory"
> & { jobDirectory: string };

export const RESUME_CLI_HELP = `Resume a durable extraction from its last committed item/page boundary.

Usage:
  mosaik resume <job-directory> [options]

Run this from the original project directory. Automation, inputs and starting URL
come from the job. Changed source or dependencies are rejected before execution.

Options:
      --data-dir <directory>    Mosaik data directory, default .mosaik
      --timeout <ms>            Runtime timeout for this invocation, default 180000
      --max-action-calls <n>    Action limit for this invocation, default 1000
      --browser <provider>      local, camoufox, or kernel
      --kernel-profile <name>   Kernel profile name to load and save
      --kernel-auth-connection <id>  Authenticated Kernel connection to load
      --kernel-stealth          Enable Kernel stealth mode
      --kernel-timeout <secs>   Kernel inactivity timeout, default 300
      --headless                Hide the browser window
      --humanize                Use human-like interactions
      --no-humanize             Disable configured humanization
      --json                    Print the full execution report as JSON
  -h, --help                    Show this help

Exit codes: 0 complete, 2 incomplete/unverified, 1 failed, 130 interrupted.
`;

export function parseResumeCliArgs(
  args: string[],
  workingDirectory = process.cwd(),
): { help: true } | { help: false; options: ResumeCliOptions } {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      timeout: { type: "string" },
      "max-action-calls": { type: "string" },
      browser: { type: "string" },
      "kernel-profile": { type: "string" },
      "kernel-auth-connection": { type: "string" },
      "kernel-stealth": { type: "boolean" },
      "kernel-timeout": { type: "string" },
      headless: { type: "boolean" },
      humanize: { type: "boolean" },
      "no-humanize": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) return { help: true };
  if (parsed.positionals.length !== 1 || !parsed.positionals[0]?.trim())
    throw new Error("Pass one durable job directory");
  const common = ["resume", "--site", "unused.invalid"];
  for (const [key, value] of Object.entries(parsed.values)) {
    if (value === undefined || value === false) continue;
    if (value === true) common.push(`--${key}`);
    else common.push(`--${key}`, value);
  }
  const base = parseExecuteCliArgs(common, workingDirectory);
  if (base.help) throw new Error("Unexpected resume help");
  const {
    automationId: _id,
    siteId: _site,
    inputs: _inputs,
    startUrl: _url,
    jobDirectory: _job,
    outputDirectory: _output,
    ...options
  } = base.options;
  return {
    help: false,
    options: { ...options, jobDirectory: resolve(workingDirectory, parsed.positionals[0]) },
  };
}

export const JOBS_CLI_HELP = `Inspect durable progress or export a fresh snapshot of committed records.

Usage:
  mosaik jobs inspect <job-directory> [--json]
  mosaik jobs export <job-directory> [--json]

Inspection works while a job runs. Export requires an inactive job and acquires
its process lock; it does not execute browser actions or change retry progress.
results.ndjson and failures.ndjson are replaceable snapshots of job.sqlite.
`;

export function parseJobsCliArgs(
  args: string[],
  workingDirectory = process.cwd(),
):
  | { help: true }
  | {
      help: false;
      options: { operation: "inspect" | "export"; jobDirectory: string; json: boolean };
    } {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) return { help: true };
  const [operation, directory, ...extra] = parsed.positionals;
  if ((operation !== "inspect" && operation !== "export") || !directory?.trim() || extra.length)
    throw new Error("Usage: mosaik jobs inspect|export <job-directory>");
  return {
    help: false,
    options: {
      operation,
      jobDirectory: resolve(workingDirectory, directory),
      json: parsed.values.json,
    },
  };
}

export const AUTOMATIONS_CLI_HELP = `List or inspect saved executable automations.

Usage:
  mosaik automations list [--site <site-id>] [--json]
  mosaik automations inspect <id> --site <site-id> [--json]

Options:
      --data-dir <directory>    Mosaik data directory, default .mosaik
  -h, --help                    Show this help
`;

export function parseAutomationsCliArgs(
  args: string[],
  workingDirectory = process.cwd(),
):
  | { help: true }
  | {
      help: false;
      options: {
        operation: "list" | "inspect";
        automationId?: string;
        siteId?: string;
        dataDirectory: string;
        json: boolean;
      };
    } {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      site: { type: "string" },
      "data-dir": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.values.help) return { help: true };
  const [operation, automationId, ...extra] = parsed.positionals;
  if (operation !== "list" && operation !== "inspect")
    throw new Error("Usage: mosaik automations list|inspect");
  if (extra.length || (operation === "list" && automationId))
    throw new Error("Unexpected automation argument");
  if (operation === "inspect" && (!automationId || !parsed.values.site?.trim()))
    throw new Error("inspect requires an automation ID and --site");
  return {
    help: false,
    options: {
      operation,
      json: parsed.values.json,
      dataDirectory: resolve(workingDirectory, parsed.values["data-dir"] ?? ".mosaik"),
      ...(parsed.values.site === undefined ? {} : { siteId: parsed.values.site }),
      ...(automationId === undefined ? {} : { automationId }),
    },
  };
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

export type ConfigCliOptions =
  | { dataDirectory: string; setting: "browser"; browser: BrowserProvider }
  | { dataDirectory: string; setting: "model"; model: string }
  | { dataDirectory: string; setting: "humanize"; value: boolean };

export type ConfigCliParseResult = { help: true } | { help: false; options: ConfigCliOptions };

export const CONFIG_CLI_HELP = `Set project-local Mosaik defaults.

Usage:
  mosaik config set browser <local|camoufox|kernel> [options]
  mosaik config set model <model> [options]
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
  if (subcommand !== "set" || setting === undefined || value === undefined) {
    throw new Error(
      "Usage: mosaik config set browser <local|kernel> | model <model> | humanize <true|false>",
    );
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
  if (setting === "browser") {
    if (!isBrowserProvider(value)) {
      throw new Error('browser must be "local", "camoufox", or "kernel"');
    }
    return { help: false, options: { setting: "browser", browser: value, dataDirectory } };
  }
  if (setting === "model") {
    const model = value.trim();
    resolveLlmRoute(model);
    return { help: false, options: { setting: "model", model, dataDirectory } };
  }
  if (setting === "humanize") {
    if (value !== "true" && value !== "false") {
      throw new Error("humanize must be true or false");
    }
    return {
      help: false,
      options: { setting: "humanize", value: value === "true", dataDirectory },
    };
  }
  throw new Error(
    "Usage: mosaik config set browser <local|camoufox|kernel> | model <model> | humanize <true|false>",
  );
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
Camoufox, provider credentials, and the data directory.

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
  mosaikPath?: string;
  install: boolean;
}

export type InitCliParseResult = { help: true } | { help: false; options: InitCliOptions };

export const INIT_CLI_HELP = `Create a pnpm TypeScript project that can import mosaik/actions and
mosaik/automations with full type resolution. Pins the installed Mosaik version.

Usage:
  mosaik init [directory] [options]

Options:
      --name <name>             Package name, default directory basename
      --mosaik-path <directory> Link a contributor checkout instead of the package version
      --no-install              Write files without running pnpm install
      --force                   Overwrite existing scaffold files
  -h, --help                    Show this help

Examples:
  mosaik init
  mosaik init ./my-bot --name my-bot
  mosaik init ./my-bot --mosaik-path /path/to/mosaik
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
      "mosaik-path": { type: "string" },
      "no-install": { type: "boolean", default: false },
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
      install: !parsed.values["no-install"],
      ...(parsed.values["mosaik-path"] === undefined
        ? {}
        : { mosaikPath: resolve(workingDirectory, parsed.values["mosaik-path"]) }),
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

export interface ProviderCliOptions {
  action: "login" | "status" | "logout";
}

export type ProviderCliParseResult = { help: true } | { help: false; options: ProviderCliOptions };

export const PROVIDER_CLI_HELP = `Sign in to a local LLM provider.

Usage:
  mosaik provider login
  mosaik provider status
  mosaik provider logout

Options:
  -h, --help                    Show this help

Login opens ChatGPT OAuth, stores a grant in $DSH_HOME/.credentials.yaml
(~/.dsh), and sets this project's default model to Codex Luna.
Logout removes only that grant. Other DSH records stay put.
This is Mosaik's own grant. It does not use ~/.codex/auth.json.
Kernel deployments still use OPENROUTER_API_KEY.
`;

export function parseProviderCliArgs(args: string[]): ProviderCliParseResult {
  const [action, ...rest] = args;
  if (action === undefined || action === "--help" || action === "-h") return { help: true };
  if (action !== "login" && action !== "status" && action !== "logout") {
    throw new Error("Usage: mosaik provider login|status|logout");
  }
  const parsed = parseArgs({
    args: rest,
    strict: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.values.help) return { help: true };
  if (parsed.positionals.length > 0) {
    throw new Error("mosaik provider does not take extra arguments");
  }
  return { help: false, options: { action } };
}

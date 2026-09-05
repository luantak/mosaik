#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import Kernel from "@onkernel/sdk";
import { DshAuthSuccessAgent } from "./agents/dsh/auth-agent.js";
import { DshCapabilityCompositionAgent } from "./agents/dsh/composition-agent.js";
import { dshResourcePath, resolveDshCommand } from "./agents/dsh/paths.js";
import { loadProjectEnv } from "./agents/dsh/session.js";
import { authAutomationId } from "./auth/automation.js";
import { localBrowserProfileDirectory } from "./auth/profile.js";
import { applySavedAuthentication, findAuthAutomationForUrl } from "./auth/session.js";
import { runLoginCommand } from "./auth/cli.js";
import { createProfileCredentialPrompter, profileCredentialsPath } from "./auth/credentials.js";
import { loginWithBrowserSession } from "./auth/login.js";
import { describeAuthSuccessCondition } from "./auth/success.js";
import { createTerminalCredentialPrompter } from "./auth/terminal.js";
import {
  runInteractiveCli,
  type InteractiveCliResult,
  type InteractiveCliSession,
} from "./cli-tui.js";
import {
  ACTIONS_CLI_HELP,
  CONFIG_CLI_HELP,
  DOCTOR_CLI_HELP,
  INIT_CLI_HELP,
  KERNEL_CLI_HELP,
  PULL_CLI_HELP,
  parseActionsCliArgs,
  parseConfigCliArgs,
  parseDoctorCliArgs,
  parseInitCliArgs,
  parseKernelCliArgs,
  parsePullCliArgs,
  parseRunCliArgs,
  RUN_CLI_HELP,
  type RunCliOptions,
} from "./cli-options.js";
import {
  createTheme,
  formatExecutionValue,
  formatDuration,
  renderCliError,
  renderDoctorReport,
  renderRootHelp,
  TaskReporter,
  type DoctorCheck,
  type DoctorReport,
} from "./cli-ui.js";
import { loadInteractiveCliHistory, saveInteractiveCliHistory } from "./config.js";
import {
  findKernelAuthConnection,
  loadMosaikConfig,
  resolveMosaikBrowser,
  saveDefaultBrowser,
} from "./config.js";
import { composeAndRun } from "./composition/index.js";
import { initializeMosaikProject } from "./init.js";
import {
  authAutomationFilePath,
  defaultLibraryNamespace,
  openFileRepository,
  pullRemoteLibrary,
  readLibraryEnvironment,
  resolveLibraryUrl,
} from "./persist/index.js";
import { openRedisLibraryBackend } from "./persist/redis-library.js";
import {
  openBrowserSession,
  openInteractiveBrowserSession,
  type BrowserSession,
  type InteractiveBrowserSession,
} from "./runtime/session.js";
import { openKernelBrowserSession } from "./kernel/browser-session.js";
import { requireAuthenticatedKernelProfile } from "./kernel/hosted-login.js";
import { deployKernelProject } from "./kernel/deploy.js";

const require = createRequire(import.meta.url);

const COMMANDS = [
  "init",
  "run",
  "login",
  "actions",
  "pull",
  "reset",
  "setup",
  "doctor",
  "kernel",
  "config",
] as const;

export async function main(args: string[], workingDirectory = process.cwd()): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case undefined: {
      const version = await packageVersion();
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const history = await loadInteractiveCliHistory(workingDirectory);
        return runInteractiveCli({
          version,
          workingDirectory,
          history,
          saveHistory: (next) => saveInteractiveCliHistory(workingDirectory, next).then(() => {}),
          openSession: (startUrl) => openInteractiveCliSession(startUrl, workingDirectory),
        });
      }
      process.stdout.write(renderRootHelp(version));
      return 0;
    }
    case "--help":
    case "-h":
      process.stdout.write(renderRootHelp(await packageVersion()));
      return 0;
    case "--version":
    case "-V":
      process.stdout.write(`${await packageVersion()}\n`);
      return 0;
    case "run":
      return runCommand(rest, workingDirectory);
    case "init":
      return initCommand(rest, workingDirectory);
    case "login":
      return runLoginCommand(rest, workingDirectory);
    case "config":
      return configCommand(rest, workingDirectory);
    case "actions":
      return actionsCommand(rest, workingDirectory);
    case "pull":
      return pullCommand(rest, workingDirectory);
    case "reset":
      return resetCommand(rest, workingDirectory);
    case "setup":
      return setupCommand(rest);
    case "doctor":
      return doctorCommand(rest, workingDirectory);
    case "kernel":
      return kernelCommand(rest, workingDirectory);
    default:
      throw new Error(unknownCommandMessage(command));
  }
}

async function pullCommand(args: string[], workingDirectory: string): Promise<number> {
  const parsed = parsePullCliArgs(args, workingDirectory);
  if (parsed.help) {
    process.stdout.write(PULL_CLI_HELP);
    return 0;
  }
  const environment = await readLibraryEnvironment(workingDirectory, parsed.options.envFile);
  const url = resolveLibraryUrl(environment);
  if (url === undefined) {
    throw new Error(`No remote library configured; add REDIS_URL to ${parsed.options.envFile}`);
  }
  const namespace =
    parsed.options.namespace ??
    environment.MOSAIK_LIBRARY_NAMESPACE ??
    (await defaultLibraryNamespace(workingDirectory));
  const remote = await openRedisLibraryBackend({ url, namespace });
  try {
    const result = await pullRemoteLibrary({
      remote,
      local: openFileRepository({
        dataRoot: resolve(workingDirectory, ".mosaik"),
        libraryRoot: workingDirectory,
      }),
      ...(parsed.options.siteId === undefined ? {} : { siteId: parsed.options.siteId }),
      dryRun: parsed.options.dryRun,
      force: parsed.options.force,
    });
    if (parsed.options.json) {
      process.stdout.write(
        `${JSON.stringify({ namespace, dryRun: parsed.options.dryRun, ...result }, null, 2)}\n`,
      );
    } else {
      const theme = createTheme();
      const prefix = parsed.options.dryRun ? "Would pull" : "Pulled";
      process.stdout.write(
        `${theme.success("✓")} ${prefix} ${result.created} new and ${result.updated} updated record${result.created + result.updated === 1 ? "" : "s"}\n` +
          `  ${theme.dim("Remote")}     ${namespace}\n` +
          `  ${theme.dim("Unchanged")}  ${result.unchanged}\n` +
          `  ${theme.dim("Conflicts")}  ${result.conflicts}\n`,
      );
      for (const conflict of result.changes.filter((change) => change.status === "conflict")) {
        process.stderr.write(
          `${theme.warning("!")} ${conflict.siteId} ${conflict.kind} ${conflict.id}: ${conflict.reason}\n`,
        );
      }
    }
    return result.conflicts === 0 ? 0 : 1;
  } finally {
    await remote.close();
  }
}

async function kernelCommand(args: string[], workingDirectory: string): Promise<number> {
  const parsed = parseKernelCliArgs(args, workingDirectory);
  if (parsed.help) {
    process.stdout.write(KERNEL_CLI_HELP);
    return 0;
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await deployKernelProject({
    projectRoot: workingDirectory,
    packageRoot,
    ...parsed.options,
  });
  if (result.exitCode === 0) {
    const theme = createTheme();
    process.stdout.write(
      `${theme.success("✓")} Packaged ${result.filesPackaged} site-library file${result.filesPackaged === 1 ? "" : "s"}\n` +
        `  ${theme.dim("Redis")}  ${result.namespace}\n`,
    );
  }
  return result.exitCode;
}

async function openInteractiveCliSession(
  startUrl: string,
  workingDirectory: string,
): Promise<InteractiveCliSession> {
  const dataDirectory = resolve(workingDirectory, ".mosaik");
  const profileDirectory = localBrowserProfileDirectory(dataDirectory, startUrl);
  const browserSession = await openInteractiveBrowserSession({
    startUrl,
    profileDirectory,
  });
  const runId = randomUUID();
  const runDirectory = resolve(dataDirectory, "runs", runId);
  const outputDirectory = resolve(runDirectory, "output");
  try {
    await mkdir(outputDirectory, { recursive: true });
  } catch (error) {
    await browserSession.close();
    throw error;
  }
  let promptNumber = 0;
  const repository = openFileRepository({
    dataRoot: dataDirectory,
    libraryRoot: workingDirectory,
  });
  try {
    await applySavedAuthentication(browserSession, repository, startUrl);
  } catch (error) {
    await browserSession.close();
    throw error;
  }
  const agent = new DshCapabilityCompositionAgent(
    browserSession,
    repository,
    dataDirectory,
    workingDirectory,
  );

  return {
    id: runId,
    currentUrl: () => browserSession.currentUrl(),
    async run(task, options): Promise<InteractiveCliResult> {
      await applySavedAuthentication(browserSession, repository, browserSession.currentUrl());
      const current = new URL(browserSession.currentUrl());
      promptNumber += 1;
      const promptDirectory = resolve(
        runDirectory,
        "prompts",
        String(promptNumber).padStart(4, "0"),
      );
      const result = await composeAndRun(agent, {
        task,
        siteId: current.host,
        startUrl: current.href,
        signal: options.signal,
        onProgress: options.onProgress,
        runDirectory: promptDirectory,
        outputDirectory,
      });
      return interactiveTaskResult(result);
    },
    async login(): Promise<InteractiveCliResult> {
      const loginUrl = browserSession.currentUrl();
      const automationId = authAutomationId(loginUrl);
      const savedAutomation = await repository.getAuthAutomation(automationId);
      const result = await loginWithBrowserSession(browserSession, {
        loginUrl,
        prompter: createProfileCredentialPrompter(
          profileDirectory,
          createTerminalCredentialPrompter(),
        ),
        successAgent: new DshAuthSuccessAgent(workingDirectory, {
          runRoot: resolve(runDirectory, "login"),
        }),
        ...(savedAutomation === undefined ? {} : { savedAutomation }),
        onAuthenticatedPage: async (_page, authenticated) => {
          await repository.saveAuthAutomation(authenticated.automation);
        },
      });
      return {
        status: "success",
        message: "Login verified",
        detail:
          `${describeAuthSuccessCondition(result.successCondition)}\n` +
          `Profile: ${result.profileDirectory}\n` +
          `Automation: ${authAutomationFilePath(dataDirectory, result.automation.id)}\n` +
          `Credentials are stored unencrypted at ${profileCredentialsPath(profileDirectory)}`,
      };
    },
    close: () => browserSession.close(),
  };
}

function interactiveTaskResult(
  result: Awaited<ReturnType<typeof composeAndRun>>,
): InteractiveCliResult {
  const duration = formatDuration(result.metrics.timings?.totalMs ?? result.metrics.durationMs);
  if (result.status !== "completed") {
    const details = [
      result.answer,
      result.reason ?? "Unknown error",
      result.runDirectory === undefined ? undefined : `Run: ${result.runDirectory}`,
      duration,
    ].filter((value): value is string => value !== undefined);
    return {
      status: "error",
      message: result.status === "refused" ? "Task refused" : "Task failed",
      detail: details.join("\n"),
    };
  }
  const summary = result.answer ?? formatExecutionValue(result.execution?.value);
  const details = [
    result.automation?.id === undefined ? undefined : `Automation: ${result.automation.id}`,
    result.reusedActions.length === 0 ? undefined : `Actions: ${result.reusedActions.join(", ")}`,
    summary,
    ...(result.execution?.files ?? []).map((file) => `Wrote: ${file.path}`),
    result.runDirectory === undefined ? undefined : `Run: ${result.runDirectory}`,
    duration,
  ].filter((value): value is string => value !== undefined);
  return { status: "success", message: "Task completed", detail: details.join("\n") };
}

async function initCommand(args: string[], workingDirectory: string): Promise<number> {
  const parsed = parseInitCliArgs(args, workingDirectory);
  if (parsed.help) {
    process.stdout.write(INIT_CLI_HELP);
    return 0;
  }
  const theme = createTheme();
  const result = await initializeMosaikProject({
    directory: parsed.options.directory,
    name: parsed.options.name,
    mosaikPackageRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    force: parsed.options.force,
  });
  process.stdout.write(
    [
      theme.success(`Initialized ${result.packageName}`),
      theme.dim(result.directory),
      "",
      "Created:",
      ...result.created.map((path) => `  ${path}`),
      "",
      `Linked mosaik from ${result.mosaikPath}`,
      "",
      "Next:",
      "  mosaik setup",
      '  mosaik run "Search for ceramic mugs" --url https://example.com --input query=mug',
      "",
    ].join("\n"),
  );
  return 0;
}

async function configCommand(args: string[], workingDirectory: string): Promise<number> {
  const parsed = parseConfigCliArgs(args, workingDirectory);
  if (parsed.help) {
    process.stdout.write(CONFIG_CLI_HELP);
    return 0;
  }
  const path = await saveDefaultBrowser(parsed.options.dataDirectory, parsed.options.browser);
  process.stdout.write(`Saved browser default ${parsed.options.browser} to ${path}\n`);
  return 0;
}

async function runCommand(args: string[], workingDirectory: string): Promise<number> {
  const parsed = parseRunCliArgs(args, workingDirectory);
  if (parsed.help) {
    process.stdout.write(RUN_CLI_HELP);
    return 0;
  }
  const options = parsed.options;
  const config = await loadMosaikConfig(options.dataDirectory);
  const browserProvider = resolveMosaikBrowser(options.browser, config);
  if (browserProvider === "local" && options.kernelAuthConnection !== undefined) {
    throw new Error("--kernel-auth-connection requires --browser kernel");
  }
  if (browserProvider === "local" && options.kernelProfile !== undefined) {
    throw new Error("--kernel-profile requires --browser kernel");
  }
  const store = openFileRepository({
    dataRoot: options.dataDirectory,
    libraryRoot: workingDirectory,
  });
  const reporter = new TaskReporter({ enabled: !options.json });
  await loadProjectEnv(workingDirectory);
  const kernel = browserProvider === "kernel" ? new Kernel() : undefined;
  let resolvedProfile = options.kernelProfile;
  if (browserProvider === "kernel" && resolvedProfile === undefined) {
    if (kernel === undefined) throw new Error("Kernel client was not initialized");
    const connectionId =
      options.kernelAuthConnection ??
      findKernelAuthConnection(config, options.startUrl)?.connectionId;
    if (connectionId === undefined) {
      throw new Error(
        `No saved Kernel login for ${new URL(options.startUrl).hostname}; run mosaik login ${options.startUrl} --browser kernel`,
      );
    }
    resolvedProfile = await requireAuthenticatedKernelProfile(
      kernel,
      connectionId,
      options.startUrl,
    );
  }
  const savedLocalAuthentication =
    browserProvider === "local"
      ? await findAuthAutomationForUrl(store, options.startUrl)
      : undefined;
  const browser = await reporter.task<Browser | BrowserSession>(
    {
      active:
        browserProvider === "kernel"
          ? "Opening a Kernel browser"
          : `Opening Chromium${options.headless ? " in headless mode" : ""}`,
      done: browserProvider === "kernel" ? "Kernel browser ready" : "Chromium ready",
    },
    () =>
      browserProvider === "kernel"
        ? openKernelBrowserSession({
            ...(kernel === undefined ? {} : { client: kernel }),
            headless: options.headless,
            stealth: options.kernelStealth,
            timeoutSeconds: options.kernelTimeoutSeconds,
            ...(resolvedProfile === undefined ? {} : { profileName: resolvedProfile }),
          })
        : savedLocalAuthentication === undefined
          ? openBrowserSession({ headless: options.headless })
          : openInteractiveBrowserSession({
              startUrl: options.startUrl,
              profileDirectory: localBrowserProfileDirectory(
                options.dataDirectory,
                options.startUrl,
              ),
              headless: options.headless,
            }),
  );
  try {
    if (browserProvider === "local" && savedLocalAuthentication !== undefined) {
      await applySavedAuthentication(browser as InteractiveBrowserSession, store, options.startUrl);
    }
    const agent = new DshCapabilityCompositionAgent(
      browser,
      store,
      options.dataDirectory,
      workingDirectory,
      options.model === undefined ? {} : { model: options.model },
    );
    const result = await reporter.task(
      { active: `Planning task for ${options.siteId}`, done: "Browser task finished" },
      () =>
        composeAndRun(agent, {
          task: options.task,
          siteId: options.siteId,
          startUrl: options.startUrl,
          inputs: options.inputs,
          ...(options.automationId === undefined ? {} : { automationId: options.automationId }),
        }),
    );
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printRunResult(result, options);
    }
    return result.status === "completed" ? 0 : 1;
  } finally {
    await browser.close();
  }
}

function printRunResult(
  result: Awaited<ReturnType<typeof composeAndRun>>,
  options: RunCliOptions,
): void {
  const theme = createTheme();
  const runLine =
    result.runDirectory === undefined ? "" : `  ${theme.dim("Run")}      ${result.runDirectory}\n`;
  if (result.status !== "completed") {
    process.stderr.write(
      `${theme.error("×")} ${theme.bold(result.status === "refused" ? "Task refused" : "Task failed")}\n` +
        (result.answer === undefined ? "" : `${result.answer}\n\n`) +
        `  ${result.reason ?? "Unknown error"}\n` +
        runLine,
    );
    return;
  }
  const duration = formatDuration(result.metrics.timings?.totalMs ?? result.metrics.durationMs);
  const automationId = result.automation?.id ?? options.automationId ?? "generated automation";
  const summary = result.answer ?? formatExecutionValue(result.execution?.value);
  process.stdout.write(
    `${theme.success("✓")} ${theme.bold("Task completed")} ${theme.dim(duration)}\n` +
      `  ${theme.dim("Automation")}  ${automationId}\n` +
      (result.reusedActions.length === 0
        ? ""
        : `  ${theme.dim("Actions")}  ${result.reusedActions.join(", ")}\n`) +
      (result.discoveredActions.length === 0
        ? ""
        : `  ${theme.dim("Learned")}  ${result.discoveredActions.join(", ")}\n`) +
      (summary === undefined ? "" : `  ${theme.dim("Result")}   ${summary}\n`) +
      (result.execution?.files ?? [])
        .map((file) => `  ${theme.dim("Wrote")}    ${file.path}\n`)
        .join("") +
      runLine,
  );
}

async function actionsCommand(args: string[], workingDirectory: string): Promise<number> {
  const parsed = parseActionsCliArgs(args, workingDirectory);
  if (parsed.help) {
    process.stdout.write(ACTIONS_CLI_HELP);
    return 0;
  }
  const repository = openFileRepository({
    dataRoot: parsed.options.dataDirectory,
    libraryRoot: workingDirectory,
  });
  const sites =
    parsed.options.siteId === undefined
      ? await repository.siteActions.listSites()
      : [parsed.options.siteId];
  const records = await Promise.all(
    sites.map(async (siteId) => ({
      siteId,
      actions: await Promise.all(
        (await repository.siteActions.list(siteId)).map(async (action) => ({
          ...action,
          evidence: await repository.siteActions.cases?.inspect(action.id),
        })),
      ),
    })),
  );
  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }
  const theme = createTheme();
  if (records.length === 0) {
    process.stdout.write(
      `${theme.bold("Learned actions")}\n\n` +
        `No actions yet. Run ${theme.accent("mosaik run")} to teach Mosaik its first site action.\n`,
    );
    return 0;
  }
  const actionCount = records.reduce((total, record) => total + record.actions.length, 0);
  process.stdout.write(
    `${theme.bold("Learned actions")}\n${theme.dim(`${actionCount} action${actionCount === 1 ? "" : "s"} across ${records.length} site${records.length === 1 ? "" : "s"}`)}\n`,
  );
  for (const record of records) {
    process.stdout.write(
      `\n${theme.accent(record.siteId)} ${theme.dim(`(${record.actions.length})`)}\n`,
    );
    if (record.actions.length === 0) process.stdout.write(`  ${theme.dim("No learned actions")}\n`);
    for (const action of record.actions) {
      const successfulRuns = action.runStats?.successfulRuns ?? 0;
      process.stdout.write(
        `  ${theme.bold(action.name)}\n` +
          `    ${action.verification} · ${action.safety} · v${action.version} · ${successfulRuns} successful run${successfulRuns === 1 ? "" : "s"}\n` +
          `    ${action.verificationBasis ?? "legacy-execution"} · ${action.evidence?.cases ?? 0} cases · ${action.evidence?.incomplete ?? 0} incomplete\n` +
          `    ${theme.dim(action.description)}\n`,
      );
    }
  }
  return 0;
}

async function resetCommand(args: string[], workingDirectory: string): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage:\n  mosaik reset [--force]\n\nDeletes learned actions and composed automations after confirmation.\n\nOptions:\n  --force    Skip confirmation, including in non-interactive terminals.\n",
    );
    return 0;
  }
  const unknown = args.find((arg) => arg !== "--force");
  if (unknown !== undefined) throw new Error(`Unknown reset option: ${unknown}`);
  const force = args.includes("--force");
  if (!force && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(
      "mosaik reset requires an interactive terminal; use --force to skip confirmation",
    );
  }

  const dataRoot = resolve(workingDirectory, ".mosaik");
  const repository = openFileRepository({ dataRoot, libraryRoot: workingDirectory });
  const inventory = await repository.inspectLearnedLibrary();
  const theme = createTheme();
  if (!force) {
    process.stdout.write(renderResetConfirmation(inventory, workingDirectory, theme));

    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = await prompt.question("> ");
    } finally {
      prompt.close();
    }
    if (!isResetConfirmation(answer)) {
      process.stdout.write(`${theme.dim("Cancelled. Nothing was deleted.")}\n`);
      return 0;
    }
  }

  const removed = await repository.clearLearnedLibrary();
  process.stdout.write(
    `${theme.success("✓")} Cleared ${removed.actions} learned action${removed.actions === 1 ? "" : "s"} and ${removed.automations} automation${removed.automations === 1 ? "" : "s"}.\n`,
  );
  return 0;
}

export function isResetConfirmation(value: string): boolean {
  return value === "i know";
}

export function renderResetConfirmation(
  inventory: { actions: number; automations: number },
  workingDirectory: string,
  theme = createTheme(),
): string {
  return `${theme.warning("This permanently deletes Mosaik's learned library.")}

Will delete:
  ${inventory.actions} learned action${inventory.actions === 1 ? "" : "s"}
  ${inventory.automations} composed automation${inventory.automations === 1 ? "" : "s"}
  ${join(workingDirectory, ".mosaik", "sites")}
  ${join(workingDirectory, "sites")}

Will keep run history and output files, browser profiles, saved logins, prompt and URL history, configuration, and API keys.

This cannot be undone by Mosaik. Type exactly "i know" to continue. Anything else cancels.
`;
}

async function setupCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage:\n  mosaik setup\n");
    return 0;
  }
  if (args.length > 0) throw new Error("mosaik setup does not accept arguments");
  const reporter = new TaskReporter();
  const packageRoot = dirname(require.resolve("playwright/package.json"));
  reporter.info("Installing Chromium with Playwright");
  const exitCode = await spawnAndWait(process.execPath, [
    resolve(packageRoot, "cli.js"),
    "install",
    "chromium",
  ]);
  if (exitCode === 0) reporter.success("Chromium is ready");
  else reporter.warning("Playwright could not install Chromium");
  return exitCode;
}

async function doctorCommand(args: string[], workingDirectory: string): Promise<number> {
  const options = parseDoctorCliArgs(args, workingDirectory);
  if (options.help) {
    process.stdout.write(DOCTOR_CLI_HELP);
    return 0;
  }
  const version = await packageVersion();
  const keyAlreadySet = Boolean(process.env.OPENROUTER_API_KEY);
  await loadProjectEnv(workingDirectory);
  const checks: DoctorCheck[] = [];
  const nodeReady = nodeVersionAtLeast(22, 18);
  checks.push({
    id: "node",
    label: "Node.js",
    status: nodeReady ? "pass" : "fail",
    detail: process.version,
    ...(nodeReady ? {} : { fix: "Install Node.js 22.18 or newer, then reopen the shell." }),
  });

  const executable = await findExecutableOnPath("mosaik");
  checks.push({
    id: "command",
    label: "Global command",
    status: executable === undefined ? "warn" : "pass",
    detail: executable ?? "mosaik is not on PATH",
    ...(executable === undefined
      ? {
          fix: "Run `pnpm add --global .`, then add the directory from `pnpm bin --global` to PATH.",
        }
      : {}),
  });

  const dsh = resolveDshCommand();
  const dshVersion = await commandOutput(dsh.executable, [...dsh.prefixArgs, "--version"]);
  checks.push({
    id: "dsh",
    label: "DSH runtime",
    status: dshVersion.ok ? "pass" : "fail",
    detail: dshVersion.ok ? dshVersion.output || dsh.prefixArgs[0]! : dshVersion.output,
    ...(dshVersion.ok
      ? {}
      : { fix: "Reinstall Mosaik with `pnpm add --global .` to restore the DSH runtime." }),
  });

  const assets = [
    dshResourcePath("composition-tools.js"),
    dshResourcePath("action-discovery-tools.js"),
    dshResourcePath("auth-profile.cordis.yml"),
  ];
  const missingAssets = await missingFiles(assets);
  checks.push({
    id: "assets",
    label: "Runtime assets",
    status: missingAssets.length === 0 ? "pass" : "fail",
    detail:
      missingAssets.length === 0
        ? `${assets.length} bundled files found`
        : `${missingAssets.length} bundled file${missingAssets.length === 1 ? "" : "s"} missing`,
    ...(missingAssets.length === 0
      ? {}
      : { fix: "Run `pnpm run build`, then reinstall Mosaik globally." }),
  });

  const chromiumPath = chromium.executablePath();
  const chromiumReady = (await missingFiles([chromiumPath])).length === 0;
  checks.push({
    id: "chromium",
    label: "Chromium",
    status: chromiumReady ? "pass" : "fail",
    detail: chromiumReady ? `${basename(chromiumPath)} installed` : "browser binary not found",
    ...(chromiumReady ? {} : { fix: "Run `mosaik setup` to install Chromium." }),
  });

  const keyReady = Boolean(process.env.OPENROUTER_API_KEY);
  checks.push({
    id: "credentials",
    label: "OPENROUTER_API_KEY",
    status: keyReady ? "pass" : "fail",
    detail: keyReady
      ? keyAlreadySet
        ? "set in environment"
        : "loaded from .env"
      : `not found in the shell or ${resolve(workingDirectory, ".env")}`,
    ...(keyReady
      ? {}
      : {
          fix: `Add OPENROUTER_API_KEY=<your key> to ${resolve(workingDirectory, ".env")}, then run Mosaik again.`,
        }),
  });

  const dataDirectory = await writableDirectoryCheck(options.dataDirectory);
  checks.push({
    id: "data",
    label: "Data directory",
    status: dataDirectory.ok ? "pass" : "fail",
    detail: dataDirectory.ok ? `${options.dataDirectory} is writable` : options.dataDirectory,
    ...(dataDirectory.ok
      ? {}
      : { fix: `Choose a writable directory with --data-dir, or fix ${options.dataDirectory}.` }),
  });

  const report: DoctorReport = {
    version,
    workingDirectory,
    dataDirectory: options.dataDirectory,
    checks,
  };
  const ok = checks.every((check) => check.status !== "fail");
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok, ...report }, null, 2)}\n`);
  } else {
    process.stdout.write(renderDoctorReport(report));
  }
  return ok ? 0 : 1;
}

async function missingFiles(paths: string[]): Promise<string[]> {
  const results = await Promise.all(
    paths.map(async (path) => {
      try {
        await access(path, constants.R_OK);
        return undefined;
      } catch {
        return path;
      }
    }),
  );
  return results.filter((path): path is string => path !== undefined);
}

async function commandOutput(
  executable: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => resolvePromise({ ok: false, output: error.message }));
    child.once("close", (code) => {
      const output = (stdout.trim() || stderr.trim()).split("\n")[0] ?? "no output";
      resolvePromise({ ok: code === 0, output });
    });
  });
}

async function findExecutableOnPath(name: string): Promise<string | undefined> {
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    for (const extension of extensions) {
      const path = join(directory, `${name}${extension}`);
      try {
        await access(path, constants.X_OK);
        return path;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

async function writableDirectoryCheck(path: string): Promise<{ ok: boolean; detail: string }> {
  let candidate = path;
  while (true) {
    try {
      await access(candidate, constants.W_OK);
      return { ok: true, detail: path };
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return { ok: false, detail: path };
      candidate = parent;
    }
  }
}

function nodeVersionAtLeast(requiredMajor: number, requiredMinor: number): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > requiredMajor || (major === requiredMajor && minor >= requiredMinor);
}

function spawnAndWait(executable: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
}

async function packageVersion(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const value: unknown = JSON.parse(
    await readFile(resolve(moduleDirectory, "../package.json"), "utf8"),
  );
  if (typeof value !== "object" || value === null || !("version" in value)) return "unknown";
  return String(value.version);
}

function unknownCommandMessage(command: string): string {
  const suggestion = COMMANDS.map((candidate) => ({
    candidate,
    distance: editDistance(command, candidate),
  })).sort((left, right) => left.distance - right.distance)[0];
  return suggestion !== undefined && suggestion.distance <= 2
    ? `Unknown command "${command}". Did you mean "mosaik ${suggestion.candidate}"?`
    : `Unknown command "${command}".`;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? right.length;
}

const cliArgs = process.argv.slice(2);
main(cliArgs)
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (cliArgs.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    const requestedCommand = cliArgs[0];
    const helpCommand = COMMANDS.some((command) => command === requestedCommand)
      ? requestedCommand
      : undefined;
    process.stderr.write(renderCliError(message, helpCommand));
    process.exitCode = 2;
  });

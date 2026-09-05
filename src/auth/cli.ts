import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Kernel from "@onkernel/sdk";
import { DshAuthSuccessAgent } from "../agents/dsh/auth-agent.js";
import { createTheme, renderCliError, TaskReporter } from "../cli-ui.js";
import {
  findKernelAuthConnection,
  loadMosaikConfig,
  resolveMosaikBrowser,
  saveKernelAuthConnection,
  type KernelAuthConnection,
} from "../config.js";
import { loadProjectEnv } from "../agents/dsh/session.js";
import {
  getKernelHostedLoginStatus,
  normalizeDomain,
  startKernelHostedLogin,
  type KernelHostedLoginStatus,
} from "../kernel/hosted-login.js";
import { authAutomationFilePath, openFileRepository } from "../persist/index.js";
import { openBrowserSession } from "../runtime/session.js";
import { authAutomationId, buildAuthAutomation } from "./automation.js";
import { loadProfileAuthAutomation } from "./automation-store.js";
import { parseLoginCliArgs, LOGIN_CLI_HELP, type LoginCliOptions } from "./cli-options.js";
import { createProfileCredentialPrompter, profileCredentialsPath } from "./credentials.js";
import { loginWithBrowserSession } from "./login.js";
import { localBrowserProfileDirectory } from "./profile.js";
import { describeAuthSuccessCondition, matchesAuthSuccessCondition } from "./success.js";
import { createTerminalCredentialPrompter } from "./terminal.js";

export async function runLoginCommand(
  args: string[],
  workingDirectory = process.cwd(),
): Promise<number> {
  const parsed = parseLoginCliArgs(args, workingDirectory);
  if (parsed.help) {
    process.stdout.write(LOGIN_CLI_HELP);
    return 0;
  }
  const options = parsed.options;
  const config = await loadMosaikConfig(options.dataDirectory);
  const browser = resolveMosaikBrowser(options.browser, config);
  if (browser === "kernel") return runKernelLoginCommand(options, workingDirectory, config);
  if (
    options.kernelProfile !== undefined ||
    options.domain !== undefined ||
    options.allowedDomains !== undefined ||
    options.noOpen ||
    options.noWait ||
    options.json
  ) {
    throw new Error("Kernel login options require --browser kernel or a Kernel project default");
  }
  return runLocalLoginCommand(options, workingDirectory);
}

async function runLocalLoginCommand(
  options: LoginCliOptions,
  workingDirectory: string,
): Promise<number> {
  const repositoryRoot = options.dataDirectory;
  const reporter = new TaskReporter();
  const theme = createTheme();
  const repository = openFileRepository(repositoryRoot);
  const automationId = authAutomationId(options.loginUrl);
  let savedAutomation = await repository.getAuthAutomation(automationId);
  if (savedAutomation === undefined) {
    const legacyCondition = await loadProfileAuthAutomation(
      options.profileDirectory,
      options.loginUrl,
    );
    if (legacyCondition !== undefined) {
      savedAutomation = buildAuthAutomation(options.loginUrl, [], legacyCondition);
    }
  }
  const session = await reporter.task(
    {
      active: `Opening Chromium for ${new URL(options.loginUrl).host}`,
      done: "Chromium ready",
    },
    () =>
      openBrowserSession({
        profileDirectory: options.profileDirectory,
        headless: options.headless,
      }),
  );
  try {
    reporter.info(
      savedAutomation === undefined ? "Starting interactive login" : "Trying saved login",
    );
    await loginWithBrowserSession(session, {
      loginUrl: options.loginUrl,
      prompter: createProfileCredentialPrompter(
        options.profileDirectory,
        createTerminalCredentialPrompter(),
      ),
      successAgent: new DshAuthSuccessAgent(workingDirectory, {
        runRoot: resolve(repositoryRoot, "runs"),
      }),
      ...(savedAutomation === undefined ? {} : { savedAutomation }),
      timeoutMs: options.timeoutMs,
      maxSteps: options.maxSteps,
      onAuthenticatedPage: async (page, authenticated) => {
        if (options.checkUrl !== undefined) {
          await page.goto(options.checkUrl, {
            waitUntil: "domcontentloaded",
            timeout: options.timeoutMs,
          });
          const verified = await matchesAuthSuccessCondition(
            page,
            authenticated.successCondition,
            options.checkUrl,
          );
          if (!verified) {
            throw new Error(`The active login session did not authenticate ${options.checkUrl}`);
          }
        }
        await repository.saveAuthAutomation(authenticated.automation);
        const description = describeAuthSuccessCondition(authenticated.successCondition);
        process.stdout.write(
          `${theme.success("✓")} ${theme.bold("Login verified")}\n` +
            `  ${theme.dim("URL")}         ${page.url()}\n` +
            `  ${theme.dim("Check")}       ${authenticated.successConditionSource === "saved" ? "reused" : "inferred"}: ${description}\n` +
            `  ${theme.dim("Profile")}     ${authenticated.profileDirectory}\n` +
            `  ${theme.dim("Automation")}  ${authAutomationFilePath(repositoryRoot, authenticated.automation.id)}\n` +
            `\n${theme.warning("!")} Credentials are stored unencrypted at\n` +
            `  ${profileCredentialsPath(authenticated.profileDirectory)}\n`,
        );
        if (options.pause) await pause();
      },
    });
  } finally {
    await session.close();
  }
  return 0;
}

async function runKernelLoginCommand(
  options: LoginCliOptions,
  workingDirectory: string,
  config: Awaited<ReturnType<typeof loadMosaikConfig>>,
): Promise<number> {
  if (
    options.profileDirectory !==
      localBrowserProfileDirectory(options.dataDirectory, options.loginUrl) ||
    options.checkUrl !== undefined ||
    options.timeoutMs !== 10000 ||
    options.maxSteps !== 5 ||
    options.pause ||
    options.headless
  ) {
    throw new Error("Kernel hosted login does not accept local browser options");
  }
  await loadProjectEnv(workingDirectory);
  const client = new Kernel();
  const loginUrl = new URL(options.loginUrl);
  const domain = normalizeDomain(options.domain ?? loginUrl.hostname);
  const saved =
    options.kernelProfile === undefined
      ? findKernelAuthConnection(config, loginUrl.href)
      : undefined;
  let mapping: KernelAuthConnection | undefined = saved;
  if (mapping !== undefined) {
    try {
      const remote = await Promise.resolve(client.auth.connections.retrieve(mapping.connectionId));
      if (
        remote === null ||
        typeof remote !== "object" ||
        (remote as unknown as Record<string, unknown>).id !== mapping.connectionId
      ) {
        throw new Error("Kernel returned a malformed auth connection");
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
      mapping = undefined;
    }
  }
  const selectedProfile = options.kernelProfile ?? mapping?.profileName;
  const started = await startKernelHostedLogin(client, {
    domain,
    ...(selectedProfile === undefined ? {} : { profileName: selectedProfile }),
    loginUrl: loginUrl.href,
    ...(options.allowedDomains === undefined ? {} : { allowedDomains: options.allowedDomains }),
  });
  const savedPath = await saveKernelAuthConnection(options.dataDirectory, {
    domain,
    loginUrl: loginUrl.href,
    connectionId: started.connectionId,
    profileName: started.profileName,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(started)}\n`);
  } else if (started.status === "authenticated") {
    process.stdout.write(
      `Login already verified\n  Connection  ${started.connectionId}\n  Profile     ${started.profileName}\n  Config      ${savedPath}\n`,
    );
    return 0;
  } else {
    process.stdout.write(
      `Login required\n  Connection  ${started.connectionId}\n  Hosted URL  ${started.hostedUrl}\n  Expires     ${started.expiresAt}\n`,
    );
  }
  if (started.status === "authenticated" || options.noWait || options.json) return 0;
  if (!options.noOpen) await openHostedUrl(started.hostedUrl);
  const status = await waitForKernelHostedLogin(client, started.connectionId, started.expiresAt);
  if (status === undefined) return 130;
  if (status.status === "authenticated") {
    process.stdout.write(
      `\nLogin verified\n  Connection  ${started.connectionId}\n  Profile     ${started.profileName}\n  Config      ${savedPath}\n\nNext:\n  mosaik run "..." --url ${loginUrl.origin} --browser kernel\n`,
    );
    return 0;
  }
  const detail = status.status === "failed" && status.message ? `: ${status.message}` : "";
  process.stderr.write(`Kernel hosted login ${status.status}${detail}\n`);
  return 1;
}

export async function waitForKernelHostedLogin(
  client: Parameters<typeof getKernelHostedLoginStatus>[0],
  connectionId: string,
  expiresAt: string,
  options: { sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<KernelHostedLoginStatus | undefined> {
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
  };
  process.once("SIGINT", onInterrupt);
  try {
    while (!interrupted && Date.parse(expiresAt) > Date.now()) {
      const status = await getKernelHostedLoginStatus(client, connectionId);
      if (status.status !== "pending") return status;
      await sleep(1_000 + Math.floor(Math.random() * 200));
    }
    return interrupted ? undefined : { status: "expired", connectionId };
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

async function openHostedUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const args = process.platform === "win32" ? ["", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => {});
  child.unref();
}

function isNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const status = "status" in error ? (error as { status?: unknown }).status : undefined;
  return status === 404;
}

async function pause(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("--pause requires an interactive terminal");
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await reader.question("Press Enter to close the browser...");
  } finally {
    reader.close();
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && pathToFileURL(resolve(entryPoint)).href === import.meta.url) {
  runLoginCommand(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(renderCliError(message, "login"));
    process.exitCode = 1;
  });
}

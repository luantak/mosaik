import type { WriteStream } from "node:tty";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
} as const;

export interface CliTheme {
  color: boolean;
  bold(value: string): string;
  dim(value: string): string;
  accent(value: string): string;
  success(value: string): string;
  warning(value: string): string;
  error(value: string): string;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  version: string;
  workingDirectory: string;
  dataDirectory: string;
  checks: DoctorCheck[];
}

export function createTheme(color = shouldUseColor(process.stdout)): CliTheme {
  const paint = (code: string, value: string) => (color ? `${code}${value}${ANSI.reset}` : value);
  return {
    color,
    bold: (value) => paint(ANSI.bold, value),
    dim: (value) => paint(ANSI.dim, value),
    accent: (value) => paint(ANSI.cyan, value),
    success: (value) => paint(ANSI.green, value),
    warning: (value) => paint(ANSI.yellow, value),
    error: (value) => paint(ANSI.red, value),
  };
}

export function shouldUseColor(stream: Pick<WriteStream, "isTTY">): boolean {
  return stream.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}

export function renderRootHelp(version: string, theme = createTheme()): string {
  return `${theme.bold(`Mosaik ${version}`)}
Browser automation built from small, reusable pieces.

${theme.bold("Usage")}
  ${theme.accent("mosaik")}                     Start an interactive browser session
  ${theme.accent("mosaik")} <command> [options]

${theme.bold("Commands")}
  ${theme.accent("init")}      Create a local TypeScript project
  ${theme.accent("run")}       Compose and run a browser task
  ${theme.accent("login")}     Save and verify a browser login
  ${theme.accent("config")}    Set project defaults
  ${theme.accent("actions")}   Inspect learned site actions
  ${theme.accent("pull")}      Pull learning from the remote library
  ${theme.accent("reset")}     Delete learned actions and automations
  ${theme.accent("setup")}     Install the Chromium browser
  ${theme.accent("doctor")}    Check that Mosaik is ready
  ${theme.accent("kernel")}    Deploy this project's site library

${theme.bold("Start here")}
  mosaik init
  mosaik setup
  mosaik doctor
  mosaik run "Search for ceramic mugs" --url https://example.com --input query=mug

Run ${theme.accent("mosaik <command> --help")} for command options.
`;
}

export function renderDoctorReport(report: DoctorReport, theme = createTheme()): string {
  const labelWidth = Math.max(...report.checks.map((check) => check.label.length), 0);
  const lines = [
    theme.bold(`Mosaik doctor ${report.version}`),
    theme.dim(`Workspace  ${report.workingDirectory}`),
    theme.dim(`Data       ${report.dataDirectory}`),
    "",
  ];
  for (const check of report.checks) {
    const symbol =
      check.status === "pass"
        ? theme.success("✓")
        : check.status === "warn"
          ? theme.warning("!")
          : theme.error("×");
    lines.push(`${symbol}  ${check.label.padEnd(labelWidth)}  ${check.detail}`);
  }
  const failures = report.checks.filter((check) => check.status === "fail");
  const warnings = report.checks.filter((check) => check.status === "warn");
  const fixes = report.checks.filter(
    (check): check is DoctorCheck & { fix: string } =>
      check.status !== "pass" && check.fix !== undefined,
  );
  lines.push("");
  if (failures.length === 0 && warnings.length === 0) {
    lines.push(theme.success("Everything looks good. Mosaik is ready."));
  } else if (failures.length === 0) {
    lines.push(
      theme.warning(`Ready with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`),
    );
  } else {
    lines.push(
      theme.error(`${failures.length} required check${failures.length === 1 ? "" : "s"} failed.`),
    );
  }
  if (fixes.length > 0) {
    lines.push("", theme.bold("Next steps"));
    fixes.forEach((check, index) => lines.push(`  ${index + 1}. ${check.fix}`));
  }
  return `${lines.join("\n")}\n`;
}

export function renderCliError(
  message: string,
  command: string | undefined,
  theme = createTheme(shouldUseColor(process.stderr)),
): string {
  const help = command === undefined ? "mosaik --help" : `mosaik ${command} --help`;
  return `${theme.error("×")} ${theme.bold(message)}\n  ${theme.dim(`Run ${help} for usage.`)}\n`;
}

export class TaskReporter {
  readonly #enabled: boolean;
  readonly #stream: WriteStream;
  readonly #theme: CliTheme;

  constructor(options: { enabled?: boolean; stream?: WriteStream } = {}) {
    this.#enabled = options.enabled ?? true;
    this.#stream = options.stream ?? process.stderr;
    this.#theme = createTheme(shouldUseColor(this.#stream));
  }

  async task<T>(labels: { active: string; done: string }, run: () => Promise<T>): Promise<T> {
    if (!this.#enabled) return run();
    const startedAt = performance.now();
    const interactive = this.#stream.isTTY === true;
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;
    const draw = () => {
      this.#stream.write(
        `\r${this.#theme.accent(frames[frame % frames.length]!)}  ${labels.active}`,
      );
      frame += 1;
    };
    let timer: NodeJS.Timeout | undefined;
    if (interactive) {
      draw();
      timer = setInterval(draw, 80);
    } else {
      this.#stream.write(`→ ${labels.active}\n`);
    }
    try {
      const value = await run();
      if (timer !== undefined) clearInterval(timer);
      const duration = formatDuration(performance.now() - startedAt);
      if (interactive) this.#stream.write("\r\u001b[2K");
      this.#stream.write(
        `${this.#theme.success("✓")}  ${labels.done} ${this.#theme.dim(duration)}\n`,
      );
      return value;
    } catch (error) {
      if (timer !== undefined) clearInterval(timer);
      if (interactive) this.#stream.write("\r\u001b[2K");
      this.#stream.write(`${this.#theme.error("×")}  ${labels.active} failed\n`);
      throw error;
    }
  }

  info(message: string): void {
    if (this.#enabled) this.#stream.write(`${this.#theme.accent("→")}  ${message}\n`);
  }

  success(message: string): void {
    if (this.#enabled) this.#stream.write(`${this.#theme.success("✓")}  ${message}\n`);
  }

  warning(message: string): void {
    if (this.#enabled) this.#stream.write(`${this.#theme.warning("!")}  ${message}\n`);
  }
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1_000)}s`;
}

export function formatExecutionValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const result = value as Record<string, unknown>;
    if (typeof result.collectedCount === "number" && typeof result.requestedCount === "number") {
      const exhaustion = result.exhausted === true ? " (site exhausted)" : "";
      return `${result.collectedCount} of ${result.requestedCount} collected${exhaustion}`;
    }
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

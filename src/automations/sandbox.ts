import { normalizeAutomationModule } from "../library/automation-module.js";
import { DownloadQueue } from "./download-queue.js";
import { Context } from "@deepseek-ai/cordis";
import WorkerThreadCodeRuntime from "@deepseek-ai/dsh-code-runtime-worker-thread";
import { validateObject, type SiteActionDefinition } from "../capabilities/index.js";
import type { CapturedBrowserResponse } from "../runtime/assets.js";
import { parseAutomationImports } from "../library/automation-imports.js";
import { resolveAutomationSourceForExecution } from "../library/resolve-automation.js";
import {
  HostActionError,
  type ActionHost,
  type ComposedAutomation,
  type AutomationExecutionResult,
} from "./types.js";
import { validateAutomation } from "./validate.js";
import { writeAutomationOutputBytes, writeAutomationOutputFile } from "./files.js";
import type { AutomationOutputFile } from "./types.js";
import { stripAutomationTypes } from "./typescript.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ACTION_CALLS = 50;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_OLD_GENERATION_MB = 64;
const MAX_OUTPUT_FILES = 128;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function transpileAutomation(source: string): string {
  return stripAutomationTypes(source).replace(/export\s+default\s+/, "exports.default = ");
}

export async function executeComposedAutomation(
  automation: ComposedAutomation,
  options: {
    host: ActionHost;
    input?: Record<string, unknown>;
    actionNames?: string[];
    actions?: SiteActionDefinition[];
    timeoutMs?: number;
    maxActionCalls?: number;
    signal?: AbortSignal;
    outputDirectory?: string;
    onFileWrite?: (file: AutomationOutputFile) => void;
    readCapturedResponse?: (
      url: string,
      options?: { reuseOnly?: boolean },
    ) => Promise<CapturedBrowserResponse>;
    libraryRoot?: string;
    loadAutomationSource?: (automationId: string) => Promise<string | undefined>;
  },
): Promise<AutomationExecutionResult> {
  const baseActionNames =
    options.actionNames ?? options.actions?.map((action) => action.name) ?? [];
  const defined = new Map((options.actions ?? []).map((action) => [action.name, action]));
  validateAutomation(automation.source, {
    ...(baseActionNames.length === 0 ? {} : { actionNames: baseActionNames }),
    ...(options.libraryRoot === undefined
      ? {}
      : {
          libraryRoot: options.libraryRoot,
          siteId: automation.siteId,
          automationId: automation.id,
        }),
  });

  let executableSource = normalizeAutomationModule(automation.source);
  let actionNames = baseActionNames;
  if (parseAutomationImports(automation.source).length > 0 || options.libraryRoot !== undefined) {
    const resolved = await resolveAutomationSourceForExecution({
      automation,
      ...(options.libraryRoot === undefined ? {} : { libraryRoot: options.libraryRoot }),
      ...(options.loadAutomationSource === undefined
        ? {}
        : { loadAutomationSource: options.loadAutomationSource }),
    });
    executableSource = resolved.source;
    if (resolved.actionNames.length > 0) {
      actionNames = [...new Set([...actionNames, ...resolved.actionNames])];
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxActionCalls = options.maxActionCalls ?? DEFAULT_MAX_ACTION_CALLS;
  const actionCalls: Array<{ name: string; args: unknown }> = [];
  const input = toJson(options.input ?? {}, "automation input");
  const controller = new AbortController();
  const files: AutomationOutputFile[] = [];
  let terminalError: string | undefined;
  let lastHostError: string | undefined;
  let failure: HostActionError["failure"];
  let halted = false;
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const actions = Object.fromEntries(
    actionNames.map((name) => [
      name,
      async (args: unknown): Promise<Json> => {
        if (controller.signal.aborted) throw abortError(controller.signal.reason);
        if (actionCalls.length >= maxActionCalls) {
          terminalError = `Action call limit of ${maxActionCalls} exceeded`;
          controller.abort(terminalError);
          throw new Error(terminalError);
        }
        const action = defined.get(name);
        if (action !== undefined) {
          try {
            validateObject(action.inputs, args ?? {}, name);
          } catch (error) {
            terminalError = messageOf(error);
            controller.abort(terminalError);
            throw error;
          }
        }
        const normalizedArgs = args ?? {};
        actionCalls.push({ name, args: normalizedArgs });
        try {
          return toJson(await options.host.invoke(name, normalizedArgs), `${name} result`);
        } catch (error) {
          lastHostError = messageOf(error);
          if (isHostFailure(error)) {
            failure = error.failure;
            halted = error.halted;
          }
          if (halted) {
            terminalError = lastHostError;
            controller.abort(terminalError);
          }
          throw error;
        }
      },
    ]),
  );

  const downloads = new DownloadQueue(4);
  let reservedFiles = 0;
  const reserveFile = () => {
    if (files.length + reservedFiles >= MAX_OUTPUT_FILES)
      throw new Error(`Output file limit of ${MAX_OUTPUT_FILES} exceeded`);
    reservedFiles++;
  };
  const fileBindings = {
    async write(request: unknown): Promise<Json> {
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      if (options.outputDirectory === undefined) {
        throw new Error("File output is unavailable for this run");
      }
      if (files.length >= MAX_OUTPUT_FILES) {
        throw new Error(`Output file limit of ${MAX_OUTPUT_FILES} exceeded`);
      }
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        throw new Error("files.write requires { path, data }");
      }
      const record = request as Record<string, unknown>;
      if (typeof record.path !== "string") throw new Error("files.write path must be a string");
      reserveFile();
      try {
        const file = await writeAutomationOutputFile(
          options.outputDirectory,
          record.path,
          record.data,
        );
        files.push(file);
        options.onFileWrite?.(file);
        return toJson(file, "written file");
      } finally {
        reservedFiles--;
      }
    },
    async download(request: unknown): Promise<Json> {
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      if (options.outputDirectory === undefined) {
        throw new Error("File output is unavailable for this run");
      }
      if (options.readCapturedResponse === undefined) {
        throw new Error("Browser response capture is unavailable for this run");
      }
      if (files.length >= MAX_OUTPUT_FILES) {
        throw new Error(`Output file limit of ${MAX_OUTPUT_FILES} exceeded`);
      }
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        throw new Error("files.download requires { url, path }");
      }
      const record = request as Record<string, unknown>;
      if (typeof record.url !== "string") throw new Error("files.download url must be a string");
      if (typeof record.path !== "string") {
        throw new Error("files.download path must be a string");
      }
      if (record.reuseOnly !== undefined && typeof record.reuseOnly !== "boolean") {
        throw new Error("files.download reuseOnly must be a boolean");
      }
      if (
        record.onConflict !== undefined &&
        record.onConflict !== "rename" &&
        record.onConflict !== "error"
      ) {
        throw new Error('files.download onConflict must be "rename" or "error"');
      }
      reserveFile();
      try {
        return await downloads.run(async () => {
          if (controller.signal.aborted) throw abortError(controller.signal.reason);
          const response = await options.readCapturedResponse!(
            record.url as string,
            record.reuseOnly === true ? { reuseOnly: true } : {},
          );
          if (controller.signal.aborted) throw abortError(controller.signal.reason);
          const file = await writeAutomationOutputBytes(
            options.outputDirectory!,
            record.path as string,
            response.bytes,
            record.onConflict === "error" ? { onConflict: "error" } : {},
          );
          files.push(file);
          options.onFileWrite?.(file);
          return toJson(
            { ...file, sourceUrl: response.url, contentType: response.contentType },
            "downloaded file",
          );
        });
      } finally {
        reservedFiles--;
      }
    },
  };

  const harness = new Context();
  try {
    await harness.plugin(WorkerThreadCodeRuntime, {
      computeMs: timeoutMs,
      maxWallMs: timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxOldGenerationSizeMb: MAX_OLD_GENERATION_MB,
    });
    const result = await harness.codeRuntime.run({
      program: wrapAutomation(transpileAutomation(executableSource), actionNames),
      bindings: [
        {
          global: "mosaik",
          functions: { input: async () => input },
        },
        { global: "actions", functions: actions },
        { global: "files", functions: fileBindings },
      ],
      signal: controller.signal,
    });
    if (result.error !== undefined || terminalError !== undefined) {
      const error =
        terminalError ??
        (result.error?.kind === "timeout"
          ? `Automation timed out after ${timeoutMs}ms`
          : result.error?.message !== undefined &&
              lastHostError !== undefined &&
              result.error.message.includes(lastHostError)
            ? lastHostError
            : (result.error?.message ?? "Automation execution failed"));
      return {
        success: false,
        logs: result.logs,
        actionCalls,
        ...(files.length === 0 ? {} : { files }),
        error,
        ...(failure === undefined ? {} : { failure }),
        ...(halted ? { halted: true } : {}),
      };
    }
    return {
      success: true,
      ...(result.value === undefined ? {} : { value: result.value }),
      logs: result.logs,
      actionCalls,
      ...(files.length === 0 ? {} : { files }),
    };
  } finally {
    controller.abort("Automation execution ended");
    options.signal?.removeEventListener("abort", onAbort);
    await harness.fiber.dispose();
  }
}

function wrapAutomation(source: string, actionNames: string[]): string {
  const facade = actionNames
    .map(
      (name) =>
        `${JSON.stringify(name)}: (args = {}) => actions[${JSON.stringify(name)}](args ?? {})`,
    )
    .join(",\n");
  return `
const exports = {};
const module = { exports };
function defineAutomation(handler) { return handler; }
${source}
const input = await mosaik.input({});
const pendingDownloads = new Set();
function download(request) {
  const pending = files.download(request);
  pendingDownloads.add(pending);
  pending.then(() => pendingDownloads.delete(pending), () => pendingDownloads.delete(pending));
  return pending;
}
const ctx = {
  input,
  output: undefined,
  log(message) { console.log(String(message)); },
  actions: {
    ${facade}
  },
  files: {
    write(path, data) { return files.write({ path, data }); },
    download,
  },
};
const handler = exports.default || module.exports.default;
if (typeof handler !== "function") {
  throw new Error("Automation must export default defineAutomation(...)");
}
let value;
try { value = await handler(ctx, input); }
finally { await Promise.allSettled([...pendingDownloads]); }
return value === undefined ? ctx.output : value;
`;
}

function abortError(reason: unknown): Error {
  const error = new Error(typeof reason === "string" ? reason : "Prompt cancelled");
  error.name = "AbortError";
  return error;
}

function toJson(value: unknown, label: string): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => toJson(item, `${label}[${index}]`));
  if (typeof value === "object") {
    const output: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = toJson(item, `${label}.${key}`);
    }
    return output;
  }
  throw new Error(`${label} must be lossless JSON`);
}

function isHostFailure(error: unknown): error is HostActionError {
  return error instanceof HostActionError;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

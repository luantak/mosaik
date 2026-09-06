import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Kernel, { type KernelContext } from "@onkernel/sdk";
import { DshCapabilityCompositionAgent } from "../agents/dsh/composition-agent.js";
import { composeAndRun } from "../composition/index.js";
import {
  openDurableMosaikStore,
  openFileRepository,
  type DurableMosaikStore,
  type LibraryPersistenceMetrics,
} from "../persist/index.js";
import { resolveLibraryUrl } from "../persist/library-config.js";
import { openKernelBrowserSession } from "./browser-session.js";
import {
  materializeKernelDshAssets,
  materializeKernelSiteLibrary,
  type KernelSiteLibraryFile,
} from "./dsh-assets.js";
import { openRedisLibraryBackend } from "./redis-library.js";
import { requireAuthenticatedKernelProfile } from "./hosted-login.js";

export interface KernelMosaikPayload {
  task: string;
  url: string;
  siteId?: string;
  inputs?: Record<string, unknown>;
  automationId?: string;
  model?: string;
  headless?: boolean;
  humanize?: boolean;
  stealth?: boolean;
  authConnectionId?: string;
  profileName?: string;
}

export type KernelLibraryPersistence = LibraryPersistenceMetrics | { mode: "ephemeral" };

export type KernelMosaikResult = Awaited<ReturnType<typeof composeAndRun>> & {
  persistence: KernelLibraryPersistence;
};

export async function runKernelMosaik(
  context: KernelContext,
  rawPayload?: unknown,
  options: {
    siteLibraryFiles?: readonly KernelSiteLibraryFile[];
    client?: Kernel;
  } = {},
): Promise<KernelMosaikResult> {
  const payload = parsePayload(rawPayload);
  const startUrl = new URL(payload.url);
  const kernel = options.client ?? new Kernel();
  const profileName =
    payload.authConnectionId === undefined
      ? payload.profileName
      : await requireAuthenticatedKernelProfile(kernel, payload.authConnectionId, payload.url);
  const siteId = payload.siteId ?? startUrl.host;
  const invocationRoot = join(tmpdir(), "mosaik", context.invocation_id);
  const dataRoot = join(invocationRoot, "data");
  const libraryRoot = join(invocationRoot, "library");
  const runDirectory = join(invocationRoot, "run");
  const outputDirectory = join(invocationRoot, "output");
  await mkdir(outputDirectory, { recursive: true });

  const projectRoot = process.cwd();
  const kernelAssetRoot = join(projectRoot, ".mosaik-kernel", context.invocation_id);
  await Promise.all([
    materializeKernelDshAssets(join(kernelAssetRoot, "dsh")),
    materializeKernelSiteLibrary(libraryRoot, options.siteLibraryFiles),
  ]);
  let durable: DurableMosaikStore | undefined;
  let browser: Awaited<ReturnType<typeof openKernelBrowserSession>> | undefined;
  try {
    const localStore = openFileRepository({ dataRoot, libraryRoot });
    const libraryUrl = resolveKernelLibraryUrl();
    durable =
      libraryUrl === undefined
        ? undefined
        : await openDurableMosaikStore({
            local: localStore,
            remote: await openRedisLibraryBackend({
              url: libraryUrl,
              ...(process.env.MOSAIK_LIBRARY_NAMESPACE === undefined
                ? {}
                : { namespace: process.env.MOSAIK_LIBRARY_NAMESPACE }),
            }),
            siteId,
          });
    const store = durable?.store ?? localStore;
    browser = await openKernelBrowserSession({
      client: kernel,
      invocationId: context.invocation_id,
      headless: payload.headless ?? true,
      ...(payload.humanize === undefined ? {} : { humanize: payload.humanize }),
      stealth: payload.stealth ?? false,
      timeoutSeconds: 300,
      ...(profileName === undefined ? {} : { saveProfileChanges: true }),
      ...(profileName === undefined ? {} : { profileName }),
    });
    const agent = new DshCapabilityCompositionAgent(
      browser,
      store,
      dataRoot,
      projectRoot,
      payload.model === undefined ? {} : { model: payload.model },
    );
    const result = await composeAndRun(agent, {
      task: payload.task,
      siteId,
      startUrl: startUrl.href,
      ...(payload.inputs === undefined ? {} : { inputs: payload.inputs }),
      ...(payload.automationId === undefined ? {} : { automationId: payload.automationId }),
      runDirectory,
      outputDirectory,
    });
    await durable?.sync();
    return {
      ...result,
      persistence: durable === undefined ? { mode: "ephemeral" } : structuredClone(durable.metrics),
    };
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await durable?.close();
      } finally {
        await rm(kernelAssetRoot, { recursive: true, force: true });
      }
    }
  }
}

export function resolveKernelLibraryUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  return resolveLibraryUrl(environment);
}

function parsePayload(value: unknown): KernelMosaikPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  const task = requiredString(payload.task, "task");
  const url = requiredString(payload.url, "url");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("url must use http or https");
  }
  if (
    parsedUrl.hostname.length === 0 ||
    parsedUrl.username.length > 0 ||
    parsedUrl.password.length > 0
  ) {
    throw new Error("url must be a web URL without credentials");
  }
  if (payload.inputs !== undefined && !isRecord(payload.inputs)) {
    throw new Error("inputs must be an object");
  }
  for (const key of [
    "siteId",
    "automationId",
    "model",
    "profileName",
    "authConnectionId",
  ] as const) {
    if (payload[key] !== undefined && typeof payload[key] !== "string") {
      throw new Error(`${key} must be a string`);
    }
  }
  if (payload.authConnectionId !== undefined && payload.profileName !== undefined) {
    throw new Error("Pass either authConnectionId or profileName, not both");
  }
  for (const key of ["headless", "humanize", "stealth"] as const) {
    if (payload[key] !== undefined && typeof payload[key] !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
  }
  return {
    task,
    url: parsedUrl.href,
    ...(payload.siteId === undefined ? {} : { siteId: payload.siteId as string }),
    ...(payload.inputs === undefined ? {} : { inputs: payload.inputs }),
    ...(payload.automationId === undefined ? {} : { automationId: payload.automationId as string }),
    ...(payload.model === undefined ? {} : { model: payload.model as string }),
    ...(payload.headless === undefined ? {} : { headless: payload.headless as boolean }),
    ...(payload.humanize === undefined ? {} : { humanize: payload.humanize as boolean }),
    ...(payload.stealth === undefined ? {} : { stealth: payload.stealth as boolean }),
    ...(payload.authConnectionId === undefined
      ? {}
      : { authConnectionId: payload.authConnectionId as string }),
    ...(payload.profileName === undefined ? {} : { profileName: payload.profileName as string }),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

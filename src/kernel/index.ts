import Kernel, { type KernelContext } from "@onkernel/sdk";
import { runKernelMosaik } from "./app.js";
import type { KernelSiteLibraryFile } from "./dsh-assets.js";
import {
  getKernelHostedLoginStatus,
  startKernelHostedLogin,
  type KernelHostedLoginRequest,
} from "./hosted-login.js";

export interface KernelMosaikAppOptions {
  siteLibraryFiles?: readonly KernelSiteLibraryFile[];
  client?: Kernel;
}

export function registerKernelMosaikApp(options: KernelMosaikAppOptions = {}): Kernel {
  const kernel = options.client ?? new Kernel();
  const app = kernel.app("mosaik");
  app.action("login", async (_context: KernelContext, payload?: unknown) =>
    startKernelHostedLogin(kernel, payload as KernelHostedLoginRequest),
  );
  app.action("login-status", async (_context: KernelContext, payload?: unknown) => {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Payload must be an object");
    }
    const connectionId = (payload as Record<string, unknown>).connectionId;
    if (typeof connectionId !== "string" || connectionId.trim().length === 0) {
      throw new Error("connectionId is required");
    }
    return getKernelHostedLoginStatus(kernel, connectionId);
  });
  app.action("run", async (context: KernelContext, payload?: unknown) =>
    runKernelMosaik(context, payload, { ...options, client: kernel }),
  );
  return kernel;
}

export { runKernelMosaik } from "./app.js";
export {
  getKernelHostedLoginStatus,
  requireAuthenticatedKernelProfile,
  startKernelHostedLogin,
} from "./hosted-login.js";
export type {
  KernelAuthConnectionClient,
  KernelHostedLoginRequest,
  KernelHostedLoginStart,
  KernelHostedLoginStatus,
} from "./hosted-login.js";
export type { KernelSiteLibraryFile } from "./dsh-assets.js";

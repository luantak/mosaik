import Kernel from "@onkernel/sdk";
import type { KernelContext } from "@onkernel/sdk/core/app-framework";
import { runKernelRuntimeProbe } from "./src/kernel/runtime-probe.js";

const kernel = new Kernel();
const app = kernel.app("mosaik-runtime-probe");

app.action("check", async (_context: KernelContext) => await runKernelRuntimeProbe());

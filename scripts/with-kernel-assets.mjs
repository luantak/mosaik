import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { buildKernelAssets, generatedKernelAssetsPath } from "./build-kernel-assets.mjs";

const command = process.argv.slice(2);
if (command.length === 0) throw new Error("A command is required");

await buildKernelAssets();
try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", ...command], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(generatedKernelAssetsPath, { force: true });
}

import { stripTypeScriptTypes } from "node:module";

let warningFilterInstalled = false;

export function suppressExperimentalTypeStripWarning(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.includes("stripTypeScriptTypes")) return;
    (emitWarning as (...values: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
}

export function stripAutomationTypes(source: string): string {
  suppressExperimentalTypeStripWarning();
  return stripTypeScriptTypes(source);
}

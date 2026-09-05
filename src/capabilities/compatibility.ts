import { actionInterfacesCompatible } from "./schema.js";
import type { ActionSchema, SiteActionDefinition } from "./types.js";

export type ActionChangeKind = "implementation" | "interface";

export function classifyActionChange(
  previous: { inputs: ActionSchema; outputs: ActionSchema },
  next: { inputs: ActionSchema; outputs: ActionSchema },
): ActionChangeKind {
  return actionInterfacesCompatible(previous, next) ? "implementation" : "interface";
}

export function assignCompatibilityVersions(
  current: SiteActionDefinition | undefined,
  next: SiteActionDefinition,
): SiteActionDefinition {
  if (current === undefined || current.id !== next.id) {
    return {
      ...next,
      interfaceVersion: next.interfaceVersion > 0 ? next.interfaceVersion : 1,
    };
  }
  if (classifyActionChange(current, next) === "implementation") {
    return {
      ...next,
      interfaceVersion: current.interfaceVersion,
      version: next.version > current.version ? next.version : current.version,
    };
  }
  return {
    ...next,
    interfaceVersion:
      next.interfaceVersion > current.interfaceVersion
        ? next.interfaceVersion
        : current.interfaceVersion + 1,
    version: next.version > current.version ? next.version : current.version + 1,
  };
}

export function formatCompatibility(input: {
  id?: string;
  actionId?: string;
  interfaceVersion: number;
  version?: number;
  actionVersion?: number;
}): string {
  const id = input.actionId ?? input.id ?? "action";
  const implementation = input.version ?? input.actionVersion ?? 1;
  return `${id}@i${input.interfaceVersion}.v${implementation}`;
}

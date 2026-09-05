import {
  applyPatches,
  compile,
  navigate,
  type Automation,
  type AutomationPatch,
} from "../core/index.js";
import { compileSiteAction } from "./define.js";
import { actionInterfacesCompatible } from "./schema.js";
import type { SiteActionDefinition } from "./types.js";

export function siteActionAsAutomation(
  action: SiteActionDefinition,
  options: { startUrl?: string } = {},
): Automation {
  const steps =
    options.startUrl === undefined
      ? action.implementation.steps
      : [
          navigate({
            id: `${action.id}::open`,
            url: options.startUrl,
            safety: "browser-local",
          }),
          ...action.implementation.steps,
        ];
  return compile({
    id: action.id,
    version: action.version,
    actions: [{ id: action.id, name: action.name, steps }],
    verification: { status: action.verification },
  });
}

export function applyActionPatches(
  action: SiteActionDefinition,
  patches: AutomationPatch[],
  implementationId?: string,
): SiteActionDefinition {
  const implementation =
    action.implementations?.find((entry) => entry.id === implementationId) ?? action.implementation;
  const relevant = patches.filter((patch) =>
    implementation.steps.some((step) => step.id === patch.stepId),
  );
  const wrapped = compile({
    id: action.id,
    version: action.version,
    actions: [
      {
        id: action.id,
        name: action.name,
        steps: structuredClone(implementation.steps),
      },
    ],
  });
  const patched = applyPatches(wrapped, relevant);
  const steps = patched.actions[0]?.steps;
  if (steps === undefined) throw new Error("Repaired action is missing steps");
  const next = compileSiteAction({
    ...action,
    implementation: action.implementations
      ? action.implementation
      : { ...implementation, steps: structuredClone(steps) },
    ...(action.implementations
      ? {
          implementations: action.implementations.map((entry) =>
            entry.id === implementation.id ? { ...entry, steps: structuredClone(steps) } : entry,
          ),
        }
      : {}),
    version: action.version + 1,
    interfaceVersion: action.interfaceVersion,
    verification: "unverified",
  });
  if (!actionInterfacesCompatible(action, next)) {
    throw new Error("Repair must not change action input/output contracts");
  }
  if (
    next.id !== action.id ||
    next.siteId !== action.siteId ||
    next.name !== action.name ||
    next.description !== action.description ||
    next.safety !== action.safety
  ) {
    throw new Error("Repair must not change action identity, site, description, or safety");
  }
  return next;
}

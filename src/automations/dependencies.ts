import { formatCompatibility } from "../capabilities/compatibility.js";
import type { SiteActionRegistry } from "../capabilities/lookup.js";
import { actionInterfacesCompatible } from "../capabilities/schema.js";
import { normalizeSiteId } from "../capabilities/site.js";
import type { ActionSchema, SiteActionDefinition } from "../capabilities/types.js";
import type { ComposedAutomation, AutomationDependency } from "./types.js";

export class AutomationDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationDependencyError";
  }
}

export function automationDependencies(actions: SiteActionDefinition[]): AutomationDependency[] {
  return actions.map((action) => ({
    actionId: action.id,
    actionVersion: action.version,
    interfaceVersion: action.interfaceVersion,
    inputs: structuredClone(action.inputs),
    outputs: structuredClone(action.outputs),
  }));
}

export function formatDependency(dependency: AutomationDependency): string {
  return `${dependency.actionId}@${dependency.actionVersion}`;
}

export function formatDependencies(dependencies: AutomationDependency[]): string[] {
  return dependencies.map(formatDependency);
}

export async function resolveAutomationActions(
  registry: SiteActionRegistry,
  automation: ComposedAutomation,
): Promise<SiteActionDefinition[]> {
  const listed = await registry.list(automation.siteId);
  const dependencies = automation.dependencies;
  if (dependencies === undefined || dependencies.length === 0) return listed;

  const siteId = normalizeSiteId(automation.siteId);
  const resolved: SiteActionDefinition[] = [];
  for (const dependency of dependencies) {
    const current =
      (await registry.get(dependency.actionId)) ??
      listed.find((action) => action.id === dependency.actionId);
    if (current === undefined) {
      throw new AutomationDependencyError(`Missing action ${dependency.actionId}`);
    }
    if (current.siteId !== siteId) {
      throw new AutomationDependencyError(
        `Action ${dependency.actionId} belongs to ${current.siteId}, not ${siteId}`,
      );
    }
    if (
      hasRecordedContract(dependency) &&
      !actionInterfacesCompatible(dependencyContract(dependency), current)
    ) {
      throw new AutomationDependencyError(
        `Action ${formatDependency(dependency)} is incompatible with the current implementation ${formatCompatibility(current)}`,
      );
    }
    resolved.push(current);
  }
  return resolved;
}

export function bindAutomationDependencies(
  automation: ComposedAutomation,
  actions: SiteActionDefinition[],
): ComposedAutomation {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const dependencies = (automation.dependencies ?? automationDependencies(actions)).map(
    (dependency) => {
      const current = byId.get(dependency.actionId);
      if (current === undefined) return dependency;
      return {
        actionId: current.id,
        actionVersion: current.version,
        interfaceVersion: dependency.interfaceVersion ?? current.interfaceVersion,
        inputs: structuredClone(dependency.inputs ?? current.inputs),
        outputs: structuredClone(dependency.outputs ?? current.outputs),
      };
    },
  );
  return {
    ...automation,
    dependencies,
    actionIds: dependencies.map((dependency) => dependency.actionId),
  };
}

function hasRecordedContract(dependency: AutomationDependency): boolean {
  return dependency.inputs !== undefined || dependency.outputs !== undefined;
}

function dependencyContract(dependency: AutomationDependency): {
  inputs: ActionSchema;
  outputs: ActionSchema;
} {
  return {
    inputs: dependency.inputs ?? {},
    outputs: dependency.outputs ?? {},
  };
}

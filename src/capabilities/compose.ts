import { formatType } from "./schema.js";
import { automationDependencies } from "../automations/dependencies.js";
import type { ComposedAutomation } from "../automations/types.js";
import { automationImportPath } from "../library/paths.js";
import { compileSiteAction } from "./define.js";
import { assertSiteCapability, classifyActionGranularity } from "./granularity.js";
import type { SiteActionRegistry } from "./lookup.js";
import {
  COMPOSITION_STEPS,
  planTask,
  type CapabilityNeed,
  type CompositionPlan,
  type CompositionStep,
} from "./plan.js";
import { normalizeSiteId } from "./site.js";
import type { SiteActionDefinition } from "./types.js";

export type { CapabilityNeed, CompositionPlan, CompositionStep } from "./plan.js";
export { COMPOSITION_STEPS } from "./plan.js";

export interface ComposeRequest {
  siteId: string;
  task: string;
  needs: CapabilityNeed[];
  discover: (need: CapabilityNeed) => Promise<SiteActionDefinition>;
  automationId?: string;
  generateAutomation?: (actions: SiteActionDefinition[]) => string;
}

export interface ComposeMetrics {
  existingActionsConsidered: number;
  knownActionsReused: number;
  missingActionsDiscovered: number;
  actionsRediscoveredUnnecessarily: number;
  inspectedBeforeDiscovery: true;
}

export interface ComposeResult {
  actions: SiteActionDefinition[];
  reused: string[];
  discovered: string[];
  rediscovered: string[];
  metrics: ComposeMetrics;
  plan: CompositionPlan;
  steps: readonly CompositionStep[];
  automation: ComposedAutomation;
}

export async function composeTask(
  registry: SiteActionRegistry,
  request: ComposeRequest,
): Promise<ComposeResult> {
  const siteId = normalizeSiteId(request.siteId);
  const plan = await planTask(registry, request);
  const ambiguous = plan.matches.find((match) => match.ambiguous === true);
  if (ambiguous !== undefined) {
    const need = ambiguous.need.name ?? ambiguous.need.intent ?? ambiguous.need.description;
    throw new Error(
      `Capability search is ambiguous for ${need ?? "unnamed capability"}; refine the need`,
    );
  }
  const known = await registry.list(siteId);
  const reused: string[] = [];
  const discovered: string[] = [];
  const rediscovered: string[] = [];
  const actions: SiteActionDefinition[] = [];

  for (const match of plan.matches) {
    if (match.action) {
      reused.push(match.action.name);
      actions.push(match.action);
      continue;
    }
    const need = match.need;
    const name = need.name;
    if (name !== undefined && classifyActionGranularity({ name }).kind === "task-specific") {
      throw new Error(`Cannot learn task-specific action ${name}; keep site capabilities reusable`);
    }
    const discoveredAction = await request.discover(need);
    const created = compileSiteAction(withNeedContext(discoveredAction, need));
    if (name !== undefined && created.name !== name) {
      throw new Error(`Discovered action ${created.name} does not match needed ${name}`);
    }
    assertSiteCapability(created);
    if (known.some((action) => action.name === created.name || action.id === created.id)) {
      rediscovered.push(created.name);
    }
    await registry.save(created);
    known.push(created);
    discovered.push(created.name);
    actions.push(created);
  }

  const source =
    request.generateAutomation === undefined
      ? generateCompositionSource(actions)
      : request.generateAutomation(actions);

  return {
    actions,
    reused,
    discovered,
    rediscovered,
    plan,
    steps: COMPOSITION_STEPS,
    metrics: {
      existingActionsConsidered: plan.considered.length,
      knownActionsReused: reused.length,
      missingActionsDiscovered: discovered.length,
      actionsRediscoveredUnnecessarily: rediscovered.length,
      inspectedBeforeDiscovery: true,
    },
    automation: {
      id: request.automationId ?? "composed",
      siteId,
      source,
      version: 1,
      actionIds: actions.map((action) => action.id),
      dependencies: automationDependencies(actions),
    },
  };
}

function withNeedContext(action: SiteActionDefinition, need: CapabilityNeed): SiteActionDefinition {
  if (need.context === undefined) return action;
  return {
    ...action,
    contexts: [...new Set([...(action.contexts ?? []), need.context])],
  };
}

export function generateCompositionSource(actions: SiteActionDefinition[]): string {
  const namedImports = [
    'import { defineAutomation } from "mosaik/automations";',
    ...new Set(
      actions.map(
        (action) =>
          `import { ${action.name} } from "${automationImportPath(action.siteId, action.name)}";`,
      ),
    ),
  ];

  const inputFields = new Map<string, string>();
  const lines = [...namedImports, "", ""];
  const handlerIndex = lines.length - 1;
  let previous: { action: SiteActionDefinition; varName: string } | undefined;

  for (const action of actions) {
    const args = callArgs(action, previous);
    for (const [key, schema] of Object.entries(action.inputs)) {
      if (args.includes(`input.${key}`))
        inputFields.set(
          key,
          `${JSON.stringify(key)}${schema.optional ? "?" : ""}: ${formatType(schema)}`,
        );
    }
    const hasOutput = Object.keys(action.outputs).length > 0;
    if (hasOutput) {
      const varName = `${action.name}Result`;
      lines.push(`  const ${varName} = await ${action.name}(ctx, ${args || "{}"});`);
      previous = { action, varName };
    } else {
      lines.push(`  await ${action.name}(ctx, ${args || "{}"});`);
    }
  }

  if (previous !== undefined) {
    lines.push(`  return ${previous.varName};`);
  } else {
    lines.push("  return {};");
  }
  lines[handlerIndex] =
    `export default defineAutomation(import.meta.url, async (ctx, input: { ${[...inputFields.values()].join("; ")} }) => {`;
  lines.push("});");
  return `${lines.join("\n")}\n`;
}

function callArgs(
  action: SiteActionDefinition,
  previous: { action: SiteActionDefinition; varName: string } | undefined,
): string {
  const entries = Object.entries(action.inputs);
  if (entries.length === 0) return "";
  const fields = entries.map(([key, schema]) => {
    if (schema.type === "object" && previous !== undefined) {
      const arrayOutput = Object.entries(previous.action.outputs).find(
        ([, type]) => type.type === "array",
      );
      if (arrayOutput !== undefined) {
        return `${key}: ${previous.varName}.${arrayOutput[0]}[0]`;
      }
    }
    return `${key}: input.${key}`;
  });
  return `{ ${fields.join(", ")} }`;
}

const BINDING_VERBS = new Set(["search", "find", "open", "add"]);

const CAPABILITY_VERBS = new Set([
  ...BINDING_VERBS,
  "apply",
  "buy",
  "cancel",
  "check",
  "checkout",
  "choose",
  "clear",
  "click",
  "close",
  "collect",
  "confirm",
  "create",
  "delete",
  "extract",
  "fill",
  "filter",
  "get",
  "go",
  "list",
  "load",
  "login",
  "logout",
  "navigate",
  "pay",
  "pick",
  "place",
  "read",
  "remove",
  "save",
  "select",
  "set",
  "show",
  "sort",
  "submit",
  "toggle",
  "update",
  "view",
  "write",
]);

const SUPERLATIVE = new Set([
  "best",
  "cheapest",
  "first",
  "highest",
  "last",
  "latest",
  "lowest",
  "newest",
  "top",
]);

const PRICE = new Set([
  "above",
  "below",
  "cheap",
  "cheaper",
  "dollar",
  "dollars",
  "euro",
  "euros",
  "expensive",
  "less",
  "more",
  "over",
  "under",
]);

export type ActionGranularity =
  | { kind: "site-capability" }
  | { kind: "task-specific"; reasons: string[] };

export function bindingVerbsIn(text: string): string[] {
  return splitIdent(text).filter((token) => BINDING_VERBS.has(token));
}

export function splitIdent(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=\D)(?=\d)|(?<=\d)(?=\D)/))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

export function classifyActionGranularity(input: {
  name: string;
  description?: string;
}): ActionGranularity {
  const tokens = splitIdent(input.name);
  const verbs = tokens.filter((token) => CAPABILITY_VERBS.has(token));
  const reasons: string[] = [];
  if (tokens.some((token) => /^\d+$/.test(token))) {
    reasons.push("name embeds a concrete value");
  }
  if (tokens.some((token) => SUPERLATIVE.has(token))) {
    reasons.push("name embeds a task ranking");
  }
  if (tokens.some((token) => PRICE.has(token))) {
    reasons.push("name embeds a price filter");
  }
  // In read/extract names, later verbs can name the subject (e.g. readDeletePolicy).
  // An explicit conjunction still denotes multiple operations.
  const readsSubject =
    ["read", "extract", "get", "list", "collect"].includes(tokens[0] ?? "") &&
    !tokens.some((token) => token === "and" || token === "then");
  if (verbs.length > 1 && !readsSubject) {
    reasons.push("name composes multiple site capabilities");
  }
  if (reasons.length === 0) return { kind: "site-capability" };
  return { kind: "task-specific", reasons };
}

export function assertSiteCapability(action: { name: string; description?: string }): void {
  if (!/^[a-z][A-Za-z0-9]*$/.test(action.name)) {
    throw new Error(`Site action names must use lowerCamelCase: ${action.name}`);
  }
  const verdict = classifyActionGranularity(action);
  if (verdict.kind === "task-specific") {
    throw new Error(
      `Task-specific action belongs in the automation, not the site library: ${action.name} (${verdict.reasons.join("; ")})`,
    );
  }
}

export interface GranularityTaskRecord {
  task: string;
  actionNames: string[];
  discovered: string[];
}

export interface GranularityReport {
  learnedNames: string[];
  taskSpecificNames: string[];
  tasks: number;
  actionsUsedInMultipleTasks: string[];
  reusable: boolean;
}

export function measureLearnedGranularity(input: {
  learned: Array<{ name: string }>;
  tasks: GranularityTaskRecord[];
}): GranularityReport {
  const learnedNames = [...new Set(input.learned.map((action) => action.name))].sort();
  const taskSpecificNames = learnedNames.filter(
    (name) => classifyActionGranularity({ name }).kind === "task-specific",
  );
  const usage = new Map<string, number>();
  for (const task of input.tasks) {
    for (const name of new Set(task.actionNames)) {
      usage.set(name, (usage.get(name) ?? 0) + 1);
    }
  }
  const actionsUsedInMultipleTasks = [...usage.entries()]
    .filter(([, count]) => count >= 2)
    .map(([name]) => name)
    .sort();
  return {
    learnedNames,
    taskSpecificNames,
    tasks: input.tasks.length,
    actionsUsedInMultipleTasks,
    reusable:
      taskSpecificNames.length === 0 &&
      learnedNames.length > 0 &&
      actionsUsedInMultipleTasks.length > 0,
  };
}

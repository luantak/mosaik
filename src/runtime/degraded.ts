import type { LocatorDefinition } from "../core/index.js";

export const PAGE_SIGNAL_INIT = `(() => {
  if (globalThis.__pwPageSignals === true) return;
  globalThis.__pwPageSignals = true;
  const proto = Element.prototype;
  const original = proto.addEventListener;
  proto.addEventListener = function (type, listener, options) {
    if (/^(click|pointerdown|pointerup|mousedown)$/.test(String(type))) {
      try {
        this.setAttribute("data-pw-listens", "1");
      } catch {
        // Some nodes reject attributes; skip the mark.
      }
    }
    return original.call(this, type, listener, options);
  };
})();`;

export interface DegradedSignals {
  visible: boolean;
  clickable: boolean;
  focusable: boolean;
  editable: boolean;
  stateful: boolean;
}

export interface DegradedNodeCandidate {
  tag: string;
  id?: string;
  text?: string;
  type?: string;
  attributes?: Record<string, string>;
  signals: DegradedSignals;
  context?: {
    form?: string;
    landmark?: string;
    nearbyText?: string[];
  };
}

export interface DegradedNodeRaw {
  tag: string;
  id?: string;
  text?: string;
  type?: string;
  attributes: Record<string, string>;
  boxVisible: boolean;
  listens: boolean;
  pointer: boolean;
  focusable: boolean;
  editable: boolean;
  stateful: boolean;
  hasTestId: boolean;
  semanticIdentity: boolean;
  adjacentToInteractive: boolean;
  form?: string;
  landmark?: string;
  nearbyText: string[];
}

export interface ExtractGranularityEvidence {
  text: string;
  granularity: "leaf" | "small-container" | "container";
  descendantCount: number;
  stableId?: string;
  semanticRole?: string;
  parentText?: string;
}

export interface TextTarget {
  locator: LocatorDefinition;
  evidence: ExtractGranularityEvidence;
}

const USEFUL_ATTRS = new Set([
  "id",
  "name",
  "type",
  "value",
  "placeholder",
  "title",
  "data-testid",
]);

const MAX_ATTR_VALUE = 64;
const MAX_OVERVIEW_DEGRADED = 16;
const MAX_TEXT_TARGETS = 8;

export function isCompactAttrValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ATTR_VALUE && !/[\s<>]/.test(value);
}

export function isConservativeCss(selector: string): boolean {
  return /^(#[A-Za-z_][\w-]*|\[data-testid="[^"[\]]{1,64}"\]|\[name="[^"[\]]{1,64}"\]|\[type="[^"[\]]{1,32}"\]\[name="[^"[\]]{1,64}"\]|\[type="[^"[\]]{1,32}"\]#[A-Za-z_][\w-]*)$/.test(
    selector,
  );
}

export function conservativeCssSelector(node: {
  id?: string;
  tag: string;
  type?: string;
  attributes?: Record<string, string>;
}): string | undefined {
  if (node.id !== undefined && /^[A-Za-z_][\w-]*$/.test(node.id)) {
    return `#${node.id}`;
  }
  const testId = node.attributes?.["data-testid"];
  if (testId !== undefined && isCompactAttrValue(testId)) {
    return `[data-testid="${cssEscapeAttr(testId)}"]`;
  }
  const name = node.attributes?.name;
  const type = node.type ?? node.attributes?.type;
  if (name !== undefined && isCompactAttrValue(name)) {
    if (type !== undefined && isCompactAttrValue(type)) {
      return `[type="${cssEscapeAttr(type)}"][name="${cssEscapeAttr(name)}"]`;
    }
    return `[name="${cssEscapeAttr(name)}"]`;
  }
  return undefined;
}

export function conservativeLocator(node: {
  id?: string;
  tag: string;
  type?: string;
  attributes?: Record<string, string>;
}): LocatorDefinition | undefined {
  const testId = node.attributes?.["data-testid"];
  if (testId !== undefined && isCompactAttrValue(testId)) {
    return { strategy: "test-id", testId };
  }
  const selector = conservativeCssSelector(node);
  if (selector === undefined) return undefined;
  return { strategy: "css", selector };
}

export function isEligibleDegraded(node: DegradedNodeRaw): boolean {
  if (node.semanticIdentity) return false;
  if (conservativeCssSelector(node) === undefined) return false;

  const identifiable =
    node.id !== undefined || node.hasTestId || node.attributes.name !== undefined;
  if (!identifiable) return false;

  if (node.hasTestId) return true;
  if (node.editable) return true;
  if (node.focusable) return true;
  if (node.listens) return true;
  if (node.pointer && node.boxVisible) return true;
  if (node.stateful && (node.boxVisible || node.id !== undefined)) return true;
  if (node.adjacentToInteractive && isStateCompanionTag(node.tag) && node.id !== undefined) {
    return true;
  }
  return false;
}

export function toDegradedCandidate(node: DegradedNodeRaw): DegradedNodeCandidate {
  const attributes = pickUsefulAttributes(node.attributes);
  const nearby = node.nearbyText.filter((item) => item.length > 0).slice(0, 3);
  const candidate: DegradedNodeCandidate = {
    tag: node.tag,
    signals: {
      visible: node.boxVisible || node.listens || node.focusable,
      clickable: node.listens || node.pointer,
      focusable: node.focusable,
      editable: node.editable,
      stateful: node.stateful || node.adjacentToInteractive,
    },
  };
  if (node.id !== undefined) candidate.id = node.id;
  if (node.text !== undefined && node.text.length > 0) candidate.text = clip(node.text, 80);
  if (node.type !== undefined) candidate.type = node.type;
  if (Object.keys(attributes).length > 0) candidate.attributes = attributes;
  const context = {
    ...(node.form === undefined ? {} : { form: node.form }),
    ...(node.landmark === undefined ? {} : { landmark: node.landmark }),
    ...(nearby.length === 0 ? {} : { nearbyText: nearby }),
  };
  if (Object.keys(context).length > 0) candidate.context = context;
  return candidate;
}

export async function collectDegradedNodes(
  page: import("playwright").Page,
): Promise<DegradedNodeCandidate[]> {
  const raw = (await page.evaluate(COLLECT_DEGRADED)) as DegradedNodeRaw[];
  return raw.filter(isEligibleDegraded).slice(0, MAX_OVERVIEW_DEGRADED).map(toDegradedCandidate);
}

export async function refineTextTargets(
  page: import("playwright").Page,
  locator: LocatorDefinition,
): Promise<TextTarget[]> {
  const handle = await resolveForEvaluate(page, locator);
  if (handle === undefined) return [];
  const selector = await selectorForHandle(locator, handle);
  if (selector === undefined) return [];
  const raw = (await page.evaluate(textTargetsFromSelectorScript(selector))) as Array<{
    selector?: string;
    testId?: string;
    text: string;
    descendantCount: number;
    stableId?: string;
    semanticRole?: string;
    parentText?: string;
  }>;
  return raw
    .map((item) => {
      const proposed = proposedTextLocator(item);
      if (proposed === undefined) return undefined;
      const evidence: ExtractGranularityEvidence = {
        text: clip(item.text, 120),
        granularity: granularityOf(item.descendantCount),
        descendantCount: item.descendantCount,
      };
      if (item.stableId !== undefined) evidence.stableId = item.stableId;
      if (item.semanticRole !== undefined) evidence.semanticRole = item.semanticRole;
      if (item.parentText !== undefined) evidence.parentText = clip(item.parentText, 120);
      return { locator: proposed, evidence };
    })
    .filter((item): item is TextTarget => item !== undefined)
    .slice(0, MAX_TEXT_TARGETS);
}

export async function collectTextTargets(
  page: import("playwright").Page,
  hint?: string,
): Promise<TextTarget[]> {
  const raw = ((await page.evaluate(pageTextTargetsScript(hint ?? ""))) ?? []) as Array<{
    selector?: string;
    testId?: string;
    text: string;
    descendantCount: number;
    stableId?: string;
    semanticRole?: string;
    parentText?: string;
  }>;
  const needle = hint?.trim().toLowerCase();
  return raw
    .filter(
      (item) =>
        needle === undefined || needle.length === 0 || item.text.toLowerCase().includes(needle),
    )
    .map((item) => {
      const proposed = proposedTextLocator(item);
      if (proposed === undefined) return undefined;
      const evidence: ExtractGranularityEvidence = {
        text: clip(item.text, 120),
        granularity: granularityOf(item.descendantCount),
        descendantCount: item.descendantCount,
      };
      if (item.stableId !== undefined) evidence.stableId = item.stableId;
      if (item.semanticRole !== undefined) evidence.semanticRole = item.semanticRole;
      if (item.parentText !== undefined) evidence.parentText = clip(item.parentText, 120);
      return { locator: proposed, evidence };
    })
    .filter((item): item is TextTarget => item !== undefined)
    .sort(
      (left, right) =>
        rankGranularity(left.evidence.granularity) - rankGranularity(right.evidence.granularity),
    )
    .slice(0, MAX_TEXT_TARGETS);
}

export function rankGranularity(value: ExtractGranularityEvidence["granularity"]): number {
  if (value === "leaf") return 0;
  if (value === "small-container") return 1;
  return 2;
}

function granularityOf(descendantCount: number): ExtractGranularityEvidence["granularity"] {
  if (descendantCount <= 0) return "leaf";
  if (descendantCount <= 2) return "small-container";
  return "container";
}

function proposedTextLocator(item: {
  selector?: string;
  testId?: string;
  stableId?: string;
  text?: string;
}): LocatorDefinition | undefined {
  if (item.testId !== undefined && isCompactAttrValue(item.testId)) {
    return { strategy: "test-id", testId: item.testId };
  }
  if (item.stableId !== undefined && /^[A-Za-z_][\w-]*$/.test(item.stableId)) {
    return { strategy: "css", selector: `#${item.stableId}` };
  }
  if (item.selector !== undefined && isConservativeCss(item.selector)) {
    return { strategy: "css", selector: item.selector };
  }
  if (item.text !== undefined && item.text.length > 0 && item.text.length <= 80) {
    return { strategy: "text", text: item.text, exact: true };
  }
  return undefined;
}

function pickUsefulAttributes(attributes: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "data-pw-listens") continue;
    if (value.length === 0 || value.length > MAX_ATTR_VALUE) continue;
    if (USEFUL_ATTRS.has(key) || key.startsWith("aria-") || compactDataAttr(key, value)) {
      next[key] = value;
    }
  }
  return next;
}

function compactDataAttr(key: string, value: string): boolean {
  return key.startsWith("data-") && key.length <= 24 && isCompactAttrValue(value);
}

function isStateCompanionTag(tag: string): boolean {
  return (
    tag === "div" ||
    tag === "span" ||
    tag === "output" ||
    tag === "p" ||
    tag === "strong" ||
    tag === "em"
  );
}

function cssEscapeAttr(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function clip(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}...`;
}

async function selectorForHandle(
  locator: LocatorDefinition,
  handle: import("playwright").Locator,
): Promise<string | undefined> {
  if (locator.strategy === "css") return locator.selector;
  if (locator.strategy === "test-id") return `[data-testid="${locator.testId}"]`;
  const id = await handle.getAttribute("id");
  if (id !== null && /^[A-Za-z_][\w-]*$/.test(id)) return `#${id}`;
  const testId = await handle.getAttribute("data-testid");
  if (testId !== null && isCompactAttrValue(testId)) return `[data-testid="${testId}"]`;
  return undefined;
}

function pageTextTargetsScript(hint: string): string {
  return `(() => {
    const needle = ${JSON.stringify(hint)}.trim().toLowerCase();
    const clipText = (value) => (value || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    const nodes = [...document.querySelectorAll("span, strong, em, b, code, time, output, p, [id], [data-testid], [role='status']")].slice(0, 120);
    const items = nodes.map((node) => {
      const text = clipText(node.innerText);
      if (!text) return undefined;
      if (needle && !text.toLowerCase().includes(needle)) return undefined;
      return {
        selector: node.id && /^[A-Za-z_][\\w-]*$/.test(node.id) ? "#" + node.id : undefined,
        testId: node.getAttribute("data-testid") || undefined,
        text,
        descendantCount: node.querySelectorAll("*").length,
        stableId: node.id || undefined,
        semanticRole: node.getAttribute("role") || undefined,
        parentText: node.parentElement ? clipText(node.parentElement.innerText) : undefined,
      };
    }).filter(Boolean);
    const seen = new Set();
    return items.filter((item) => {
      const key = (item.selector || item.testId || item.stableId || item.text) + ":" + item.descendantCount;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })()`;
}

function textTargetsFromSelectorScript(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return [];
    const clipText = (value) => (value || "").replace(/\\s+/g, " ").trim().slice(0, 120);
    const descendants = [...element.querySelectorAll("span, strong, em, b, code, time, output, [id], [data-testid]")];
    const parentText = element.parentElement ? clipText(element.parentElement.innerText) : undefined;
    const items = [element, ...descendants].map((node) => {
      const text = clipText(node.innerText);
      if (!text) return undefined;
      return {
        selector: node.id && /^[A-Za-z_][\\w-]*$/.test(node.id) ? "#" + node.id : undefined,
        testId: node.getAttribute("data-testid") || undefined,
        text,
        descendantCount: node.querySelectorAll("*").length,
        stableId: node.id || undefined,
        semanticRole: node.getAttribute("role") || undefined,
        parentText: node === element ? parentText : clipText(element.innerText),
      };
    }).filter(Boolean);
    const seen = new Set();
    return items.filter((item) => {
      const key = (item.selector || item.testId || item.text) + ":" + item.descendantCount;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 8);
  })()`;
}

async function resolveForEvaluate(
  page: import("playwright").Page,
  locator: LocatorDefinition,
): Promise<import("playwright").Locator | undefined> {
  const { resolveLocator } = await import("./locators.js");
  const handle = resolveLocator(page, locator);
  if ((await handle.count()) !== 1) return undefined;
  return handle;
}

const COLLECT_DEGRADED = `(() => {
  const implicitRole = (tag) =>
    tag === "button" ? "button"
      : tag === "a" ? "link"
        : tag === "select" ? "combobox"
          : tag === "textarea" || tag === "input" ? "textbox"
            : undefined;
  const visibleBox = (element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && !element.hasAttribute("hidden")
      && bounds.width > 0 && bounds.height > 0;
  };
  const labelFor = (element) => {
    if (element.id) {
      const byFor = element.ownerDocument.querySelector('label[for="' + CSS.escape(element.id) + '"]');
      const forText = byFor && byFor.textContent && byFor.textContent.trim();
      if (forText) return forText;
    }
    const parent = element.closest("label");
    const parentText = parent && parent.textContent && parent.textContent.trim();
    return parentText || undefined;
  };
  const formNameOf = (element) => {
    const form = element.closest("form");
    if (!form) return undefined;
    return form.getAttribute("aria-label") || form.getAttribute("name") || form.id || undefined;
  };
  const landmarkOf = (element) => {
    const landmarkNode = element.closest("header, nav, main, footer, aside, section, [role='banner'], [role='navigation'], [role='main'], [role='contentinfo'], [role='complementary']");
    if (!landmarkNode) return undefined;
    const landmarkRole = landmarkNode.getAttribute("role") || landmarkNode.tagName.toLowerCase();
    const heading = landmarkNode.querySelector("h1, h2, h3");
    const landmarkName = landmarkNode.getAttribute("aria-label") || (heading && heading.textContent && heading.textContent.trim()) || undefined;
    return landmarkName ? landmarkRole + ":" + landmarkName : landmarkRole;
  };
  const nearbyText = (element) => {
    const texts = [];
    const push = (node) => {
      if (!node) return;
      const value = (node.innerText || node.textContent || "").trim().replace(/\\s+/g, " ");
      if (value && value !== (element.innerText || "").trim() && value.length <= 80) texts.push(value);
    };
    push(element.previousElementSibling);
    push(element.nextElementSibling);
    if (element.parentElement) {
      const own = (element.innerText || "").trim();
      const parent = (element.parentElement.innerText || "").trim().replace(/\\s+/g, " ");
      if (parent && parent !== own) texts.push(parent.slice(0, 80));
    }
    return [...new Set(texts)].slice(0, 3);
  };
  const usefulAttrs = (element) => {
    const out = {};
    for (const attr of element.attributes) {
      if (attr.name === "data-pw-listens") continue;
      if (attr.value && attr.value.length <= 64) out[attr.name] = attr.value;
    }
    return out;
  };
  const isInteractive = (element) => {
    const tag = element.tagName.toLowerCase();
    return tag === "button" || tag === "a" || tag === "input" || tag === "select" || tag === "textarea"
      || element.hasAttribute("data-pw-listens") || element.getAttribute("role") === "button"
      || element.getAttribute("role") === "link";
  };
  const nodes = [...document.querySelectorAll(
    "[id], [data-testid], [name], [tabindex], [contenteditable], [data-pw-listens], input, select, textarea, button, [aria-live], [role='status'], [role='output'], output, meter, progress",
  )].slice(0, 200);
  return nodes.filter((element) => !element.closest("[hidden], [aria-hidden='true']")).map((element) => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || implicitRole(tag);
    const label = labelFor(element);
    const aria = element.getAttribute("aria-label");
    const name = aria || label;
    const text = (element.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 80) || undefined;
    const listens = element.getAttribute("data-pw-listens") === "1" || element.hasAttribute("onclick");
    const style = getComputedStyle(element);
    const tabindex = element.tabIndex;
    const editable = element.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
    const focusable = tabindex >= 0 || editable || tag === "button" || tag === "a";
    const stateful = element.hasAttribute("aria-live") || role === "status" || role === "output"
      || tag === "output" || tag === "meter" || tag === "progress" || (Boolean(text) && Boolean(element.id));
    const siblingInteractive = Boolean(
      element.parentElement && [...element.parentElement.children].some((child) => child !== element && isInteractive(child)),
    );
    return {
      tag,
      id: element.id || undefined,
      text,
      type: element.getAttribute("type") || undefined,
      attributes: usefulAttrs(element),
      boxVisible: visibleBox(element),
      listens,
      pointer: style.cursor === "pointer" || listens,
      focusable,
      editable,
      stateful,
      hasTestId: Boolean(element.getAttribute("data-testid")),
      semanticIdentity: Boolean(name),
      adjacentToInteractive: siblingInteractive,
      form: formNameOf(element),
      landmark: landmarkOf(element),
      nearbyText: nearbyText(element),
    };
  });
})()`;

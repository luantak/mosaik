import type { LocatorDefinition } from "../core/types.js";
import type { Page } from "playwright";
import { collectDegradedNodes, type DegradedNodeCandidate } from "./degraded.js";

export interface InteractiveElement {
  tag: string;
  href?: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  id?: string;
  testId?: string;
  formName?: string;
  landmark?: string;
  heading?: string;
  visible: boolean;
  enabled: boolean;
}

export interface PageHeading {
  locator?: LocatorDefinition;
  level: number;
  text: string;
}

export interface PageImage {
  locator: LocatorDefinition;
  alt: string;
  src: string;
}

export interface PageCollection {
  rowLocator: LocatorDefinition;
  count: number;
  sampleText: string[];
}

export interface PageFormField {
  label?: string;
  role?: string;
  name?: string;
  id?: string;
  testId?: string;
  enabled: boolean;
}

export interface PageForm {
  name?: string;
  id?: string;
  fieldLabels: string[];
  fields: PageFormField[];
}

export interface PageOverview {
  url: string;
  title: string;
  headings: PageHeading[];
  images?: PageImage[];
  collections?: PageCollection[];
  landmarks: Array<{ role: string; name?: string; id?: string; interactiveCount: number }>;
  forms: PageForm[];
  interactive: InteractiveElement[];
  degraded?: DegradedNodeCandidate[];
  text: string;
}

export interface PageRegion {
  landmark?: string;
  formName?: string;
  controls: Array<{
    locator?: LocatorDefinition;
    href?: string;
    role?: string;
    name?: string;
    label?: string;
    id?: string;
    testId?: string;
    heading?: string;
    enabled: boolean;
  }>;
}

export interface PageSnapshot {
  url: string;
  title: string;
  headings: PageHeading[];
  images?: PageImage[];
  collections?: PageCollection[];
  landmarks: Array<PageOverview["landmarks"][number] & { locator: LocatorDefinition }>;
  forms: Array<{
    name?: string;
    id?: string;
    fields: PageFormField[];
  }>;
  regions: PageRegion[];
  inactive: Array<{
    role?: string;
    name?: string;
    reason: "hidden" | "disabled";
  }>;
  degraded: Array<{
    tag: string;
    id?: string;
    text?: string;
    signals: DegradedNodeCandidate["signals"];
  }>;
}

const COLLECT_OVERVIEW = `(() => {
  const implicitRole = (tag) =>
    tag === "button" ? "button"
      : tag === "a" ? "link"
        : tag === "select" ? "combobox"
          : tag === "textarea" || tag === "input" ? "textbox"
            : undefined;
  const semanticText = (element) => {
    const clone = element.cloneNode(true);
    for (const hidden of clone.querySelectorAll('[aria-hidden="true"], [hidden]')) hidden.remove();
    const text = (clone.textContent || "").trim().replace(/\\s+/g, " ");
    return text || undefined;
  };
  const visibleEnabled = (element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      visible: style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0 && !element.hasAttribute("hidden"),
      enabled: !("disabled" in element) || element.disabled !== true,
    };
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
    const roles = { header: "banner", nav: "navigation", main: "main", footer: "contentinfo", aside: "complementary", section: "region" };
    const landmarkRole = landmarkNode.getAttribute("role") || roles[landmarkNode.tagName.toLowerCase()];
    const labelledBy = (landmarkNode.getAttribute("aria-labelledby") || "").split(/\\s+/).map(id => document.getElementById(id)?.textContent?.trim() || "").filter(Boolean).join(" ");
    const landmarkName = labelledBy || landmarkNode.getAttribute("aria-label") || undefined;
    return landmarkName ? landmarkRole + ":" + landmarkName : landmarkRole;
  };
  const headingOf = (element) => {
    const root = element.closest("form, section, fieldset, article") || element.parentElement;
    const heading = root && root.querySelector("h1, h2, h3, legend");
    const text = heading && heading.textContent && heading.textContent.trim();
    return text || undefined;
  };
  const dropEmpty = (value) => {
    const next = {};
    for (const key of Object.keys(value)) {
      if (value[key] !== undefined && value[key] !== "") next[key] = value[key];
    }
    return next;
  };
  const interactive = [...document.querySelectorAll("button, a[href], input, select, textarea, [role]")].map((element) => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || implicitRole(tag);
    const text = semanticText(element);
    const label = labelFor(element);
    const name = element.getAttribute("aria-label") || label || text;
    const state = visibleEnabled(element);
    return dropEmpty({
      tag,
      role,
      name,
      label,
      text,
      id: element.id || undefined,
      testId: element.getAttribute("data-testid") || undefined,
      href: element.getAttribute("href") || undefined,
      formName: formNameOf(element),
      landmark: landmarkOf(element),
      heading: headingOf(element),
      visible: state.visible,
      enabled: state.enabled,
    });
  });
  const headingSelector = (node) => {
    if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1)
      return '#' + CSS.escape(node.id);
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement ? [...current.parentElement.children].filter(item => item.tagName === current.tagName) : [current];
      parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')');
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, legend, [role='heading']")].map((node) => {
    const tag = node.tagName.toLowerCase();
    const selector = headingSelector(node);
    return { locator: document.querySelectorAll(selector).length === 1 && document.querySelector(selector) === node ? {strategy: "css", selector} : undefined, level: Number(node.getAttribute("aria-level")) || (tag === "legend" ? 2 : Number(tag.slice(1))) || 2, text: (node.textContent || "").trim().replace(/\\s+/g, " ") };
  }).filter((item) => item.text);
  const forms = [...document.querySelectorAll("form")].map((form) => {
    const labels = [...form.querySelectorAll("label")].map((item) => item.innerText.trim().replace(/\\s+/g, " ")).filter(Boolean);
    const fields = [...form.querySelectorAll("input, select, textarea, button")].map((element) => {
      const tag = element.tagName.toLowerCase();
      const label = labelFor(element);
      const text = semanticText(element);
      return dropEmpty({
        label,
        role: element.getAttribute("role") || implicitRole(tag),
        name: element.getAttribute("aria-label") || label || text,
        id: element.id || undefined,
        testId: element.getAttribute("data-testid") || undefined,
        enabled: visibleEnabled(element).enabled,
      });
    });
    return dropEmpty({
      name: form.getAttribute("aria-label") || form.getAttribute("name") || undefined,
      id: form.id || undefined,
      fieldLabels: labels,
      fields,
    });
  });
  const images = [...document.querySelectorAll("img")]
    .filter(node => visibleEnabled(node).visible)
    .map(node => ({locator:{strategy:"css",selector:headingSelector(node)},alt:node.alt || "",src:node.currentSrc || node.src}));
  const collections = [...document.querySelectorAll("ul,ol,tbody,[role=list],[role=grid],[role=table]")]
    .map(container => {
      const row = container.matches("ul,ol") ? "li" : container.matches("tbody") ? "tr" : '[role=listitem],[role=row]';
      const rows = [...container.children].filter(child => child.matches(row));
      if (rows.length < 2) return null;
      const prefix = headingSelector(container);
      return {rowLocator:{strategy:"css",selector:row.split(",").map(part => prefix + " > " + part).join(",")},count:rows.length,sampleText:rows.slice(0,3).map(node => (node.textContent || "").trim().replace(/\\s+/g," ").slice(0,240))};
    }).filter(Boolean);
  return { interactive, headings, forms, images, collections };
})()`;

export async function collectOverview(page: Page): Promise<PageOverview> {
  const collected = (await page.evaluate(COLLECT_OVERVIEW)) as {
    interactive: InteractiveElement[];
    headings: PageHeading[];
    forms: PageForm[];
    images: PageImage[];
    collections: PageCollection[];
  };
  await readAccessibleControlNames(page, collected.interactive);
  const title = await page.title();
  const url = page.url();
  const degraded = await collectDegradedNodes(page);
  const landmarks = await readAccessibleLandmarks(page);
  const overview: PageOverview = {
    url,
    title,
    headings: collected.headings,
    landmarks,
    forms: collected.forms,
    interactive: collected.interactive,
    ...(collected.collections.length ? { collections: collected.collections } : {}),
    ...(collected.images.length ? { images: collected.images } : {}),
    degraded,
    text: "",
  };
  overview.text = formatOverviewText(overview);
  return overview;
}

export function toPageSnapshot(overview: PageOverview): PageSnapshot {
  const visible = overview.interactive.filter((item) => item.visible);
  const regions = new Map<string, PageRegion>();
  for (const item of visible) {
    const key = `${item.landmark ?? ""}|${item.formName ?? ""}`;
    const existing = regions.get(key);
    const locator: LocatorDefinition | undefined = item.testId
      ? { strategy: "test-id", testId: item.testId }
      : item.role
        ? {
            strategy: "role",
            role: item.role,
            ...(item.name === undefined ? {} : { name: item.name, exact: true }),
          }
        : undefined;
    const control = {
      ...(locator === undefined ? {} : { locator }),
      ...(item.href === undefined ? {} : { href: item.href }),
      ...(item.role === undefined ? {} : { role: item.role }),
      ...(item.name === undefined ? {} : { name: item.name }),
      ...(item.label === undefined ? {} : { label: item.label }),
      ...(item.id === undefined ? {} : { id: item.id }),
      ...(item.testId === undefined ? {} : { testId: item.testId }),
      ...(item.heading === undefined ? {} : { heading: item.heading }),
      enabled: item.enabled,
    };
    if (existing === undefined) {
      regions.set(key, {
        ...(item.landmark === undefined ? {} : { landmark: item.landmark }),
        ...(item.formName === undefined ? {} : { formName: item.formName }),
        controls: [control],
      });
    } else {
      existing.controls.push(control);
    }
  }
  return {
    url: overview.url,
    title: overview.title,
    headings: overview.headings,
    landmarks: overview.landmarks.map((landmark) => ({
      ...landmark,
      locator: {
        strategy: "role",
        role: landmark.role,
        ...(landmark.name === undefined ? {} : { name: landmark.name, exact: true }),
      },
    })),
    forms: overview.forms.map((form) => ({
      ...(form.name === undefined ? {} : { name: form.name }),
      ...(form.id === undefined ? {} : { id: form.id }),
      fields: form.fields,
    })),
    regions: [...regions.values()],
    inactive: overview.interactive
      .filter((item) => !item.visible || !item.enabled)
      .slice(0, 24)
      .map((item) => ({
        ...(item.role === undefined ? {} : { role: item.role }),
        ...(item.name === undefined ? {} : { name: item.name }),
        reason: item.visible ? ("disabled" as const) : ("hidden" as const),
      })),
    degraded: (overview.degraded ?? []).map((item) => ({
      tag: item.tag,
      signals: item.signals,
      ...(item.id === undefined ? {} : { id: item.id }),
      ...(item.text === undefined ? {} : { text: item.text }),
    })),
    ...(overview.collections?.length ? { collections: overview.collections } : {}),
    ...(overview.images?.length ? { images: overview.images } : {}),
  };
}

export function formatOverviewText(overview: PageOverview): string {
  const snapshot = toPageSnapshot(overview);
  return [
    `URL: ${overview.url}`,
    `Title: ${JSON.stringify(overview.title)}`,
    snapshot.headings.length === 0
      ? "Headings: none"
      : `Headings: ${snapshot.headings.map((item) => `${"#".repeat(item.level)} ${item.text}`).join(" | ")}`,
    `Landmarks: ${
      snapshot.landmarks.length === 0
        ? "none"
        : snapshot.landmarks
            .map(
              (item) =>
                `${item.role}${item.name === undefined ? "" : ` "${item.name}"`} (${item.interactiveCount})`,
            )
            .join(", ")
    }`,
    snapshot.forms.length === 0
      ? "Forms: none"
      : `Forms: ${snapshot.forms
          .map((form) => {
            const fields = form.fields
              .map(
                (field) =>
                  `${field.role ?? "field"}${field.name === undefined ? "" : ` "${field.name}"`}${
                    field.testId === undefined ? "" : ` testid=${field.testId}`
                  }${field.id === undefined ? "" : ` #${field.id}`}`,
              )
              .join(", ");
            return `${form.name ?? form.id ?? "unnamed"} [${fields}]`;
          })
          .join(" | ")}`,
    `Regions: ${snapshot.regions
      .map((region) => {
        const where = [region.landmark, region.formName]
          .filter((item) => item !== undefined)
          .join("/");
        const controls = region.controls
          .map(
            (item) =>
              `${item.role ?? "control"}${item.name === undefined ? "" : ` "${item.name}"`}`,
          )
          .join(", ");
        return `${where || "page"}: ${controls}`;
      })
      .join(" || ")}`,
    snapshot.inactive.length === 0
      ? "Inactive: none"
      : `Inactive: ${snapshot.inactive.map((item) => `${item.role ?? "control"} "${item.name ?? "?"}" (${item.reason})`).join(", ")}`,
    snapshot.degraded.length === 0
      ? "Degraded: none"
      : `Degraded: ${snapshot.degraded
          .map((item) => {
            const marks = [
              item.signals.clickable ? "clickable" : undefined,
              item.signals.stateful ? "stateful" : undefined,
              item.signals.focusable ? "focusable" : undefined,
            ].filter((mark): mark is string => mark !== undefined);
            return `${item.id === undefined ? item.tag : `#${item.id}`}${
              marks.length === 0 ? "" : ` (${marks.join(" ")})`
            }`;
          })
          .join(" | ")}`,
  ].join("\n");
}

async function readAccessibleControlNames(
  page: Page,
  controls: InteractiveElement[],
): Promise<void> {
  const elements = await page.locator("button, a[href], input, select, textarea, [role]").all();
  let index = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (index < controls.length) {
        const current = index++;
        const control = controls[current]!;
        const element = elements[current];
        if (!control.visible || !element || !control.role) continue;
        // Use the same accessibility implementation as Playwright role locators.
        // textContent concatenates adjacent nodes and includes CSS-hidden shortcuts.
        try {
          const snapshot = await element.ariaSnapshot({ timeout: 500 });
          const root = snapshot.split("\n")[0]?.match(/^- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?/);
          delete control.name;
          if (root?.[1]) control.role = root[1];
          if (root?.[2] !== undefined) control.name = JSON.parse(`"${root[2]}"`) as string;
        } catch {
          // A disappearing control must not retain a guessed accessible name.
          delete control.name;
        }
      }
    }),
  );
}

async function readAccessibleLandmarks(page: Page): Promise<PageOverview["landmarks"]> {
  const elements = await page
    .locator(
      "header, nav, main, footer, aside, section, [role='banner'], [role='navigation'], [role='main'], [role='contentinfo'], [role='complementary'], [role='region']",
    )
    .all();
  const landmarks: PageOverview["landmarks"] = [];
  for (const element of elements) {
    const snapshot = await element.ariaSnapshot({ timeout: 500 });
    const root = snapshot
      .split("\n")[0]
      ?.match(
        /^- (banner|navigation|main|contentinfo|complementary|region)(?: "((?:[^"\\]|\\.)*)")?(?=[: []|$)/,
      );
    if (!root?.[1]) continue;
    const id = await element.getAttribute("id");
    landmarks.push({
      role: root[1],
      ...(root[2] === undefined ? {} : { name: JSON.parse(`"${root[2]}"`) as string }),
      ...(id ? { id } : {}),
      interactiveCount: await element
        .locator("button, a[href], input, select, textarea, [role]")
        .count(),
    });
  }
  return landmarks;
}

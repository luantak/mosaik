import type { ElementHandle, Page } from "playwright";
import type { LocatorDefinition, StepValue } from "../../core/types.js";
import { resolveLocator } from "../../runtime/locators.js";
import { locatorAlternatives } from "../../runtime/locator-alternatives.js";
import { DomRevision } from "./dom-revision.js";

interface ReferenceDescription {
  label: string;
  context?: string;
  tag: string;
  role?: string;
  href?: string;
}
interface ReferenceCapture {
  elements: Array<ReferenceDescription & { elementRef: string }>;
  truncated: boolean;
}

/** References identify observed DOM nodes; only their compiled locators are persisted. */
export class ElementReferences {
  private next = 1;
  private snapshotReferences = new Map<string, string>();
  private revision = new DomRevision();
  private cached: { revision: string; snapshot: string; result: ReferenceCapture } | undefined;
  private entries = new Map<
    string,
    ReferenceDescription & { locator: LocatorDefinition; element: ElementHandle }
  >();

  describe(ref: string) {
    const entry = this.entries.get(ref);
    if (!entry) throw new Error(`Unknown element reference ${ref}; get an updated overview`);
    return {
      label: entry.label,
      tag: entry.tag,
      ...(entry.role ? { role: entry.role } : {}),
      ...(entry.href ? { href: entry.href } : {}),
      ...(entry.context ? { context: entry.context } : {}),
    };
  }

  assertLabel(ref: string, expectedLabel: string) {
    const actual = this.describe(ref);
    if (actual.label !== expectedLabel)
      throw new Error(
        `Element ${ref} is ${JSON.stringify(actual)}, not ${JSON.stringify(expectedLabel)}. No action was performed. Choose the reference with the intended label and context from the overview.`,
      );
  }

  definition(ref: string): LocatorDefinition {
    const entry = this.entries.get(ref);
    if (!entry) throw new Error(`Unknown element reference ${ref}; get an updated overview`);
    return structuredClone(entry.locator);
  }

  async resolve(page: Page, ref: string): Promise<LocatorDefinition> {
    const locator = this.definition(ref);
    const entry = this.entries.get(ref)!;
    try {
      const target = resolveLocator(page, locator);
      if (
        (await target.count()) === 1 &&
        (await target.evaluate(
          (node, observed) => node === observed && node.isConnected,
          entry.element,
        ))
      )
        return locator;
    } catch {
      /* Navigation or replacement detached the observed node. */
    }
    throw new Error(`Stale element reference ${ref}; get an updated overview before acting`);
  }

  async bind(page: Page, ref: string, value: StepValue, inputs: Record<string, unknown>) {
    let locator = await this.resolve(page, ref);
    const entry = this.entries.get(ref)!;
    if (locator.strategy === "css") {
      const scope = await entry.element.evaluate((node) => {
        const role =
          (node as Element).getAttribute("role") ??
          (
            { BUTTON: "button", A: "link", INPUT: "textbox", SELECT: "combobox" } as Record<
              string,
              string
            >
          )[(node as Element).tagName];
        const parts: string[] = [];
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const siblings = parent.parentElement
            ? Array.from(parent.parentElement.children).filter(
                (child) => child.tagName === parent!.tagName,
              )
            : [parent];
          parts.unshift(
            `${parent.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(parent) + 1})`,
          );
          const selector = parts.join(" > ");
          if (document.querySelectorAll(selector).length === 1) return { role, selector };
        }
        return { role, selector: "html" };
      });
      if (!scope.role)
        throw new Error(
          `Reference ${ref} is ${JSON.stringify(this.describe(ref))}, not a parameterizable control. Choose the intended control reference; for a collected URL use exploreNavigate with inputKey.`,
        );
      locator = {
        strategy: "role",
        role: scope.role,
        name: entry.label,
        exact: true,
        within: { kind: "container", locator: { strategy: "css", selector: scope.selector } },
      };
    }
    const field = { role: "name", text: "text", label: "label", "test-id": "testId" }[
      locator.strategy
    ];
    const bound: LocatorDefinition = { ...locator, bindings: { [field]: value } };
    const target = resolveLocator(page, bound, inputs);
    if (
      (await target.count()) !== 1 ||
      !(await target.evaluate((node, original) => node === original, entry.element))
    )
      throw new Error(
        "The example binding does not select the referenced element uniquely. Keep the intended label and context; correct the example value without clicking.",
      );
    return bound;
  }

  async capture(page: Page, snapshot: unknown): Promise<ReferenceCapture> {
    const revision = await this.revision.read(page);
    const snapshotKey = JSON.stringify(snapshot);
    if (revision && this.cached?.revision === revision && this.cached.snapshot === snapshotKey)
      return structuredClone(this.cached.result);
    this.cached = undefined;
    this.snapshotReferences.clear();
    const finish = async (result: ReferenceCapture) => {
      if (revision && (await this.revision.read(page)) === revision)
        this.cached = { revision, snapshot: snapshotKey, result: structuredClone(result) };
      return result;
    };
    const candidates: Array<{
      locator: LocatorDefinition;
      label: string;
      context?: string;
      role?: string;
    }> = [];
    const walk = (value: unknown, context?: string) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item, context);
        return;
      }
      const item = value as Record<string, unknown>;
      const scope = typeof item.landmark === "string" ? item.landmark : context;
      if (item.locator && typeof item.locator === "object")
        candidates.push({
          locator: item.locator as LocatorDefinition,
          label: String(item.name ?? item.label ?? item.text ?? item.alt ?? item.role ?? "element"),
          ...(typeof item.role === "string" ? { role: item.role } : {}),
          ...(scope ? { context: scope } : {}),
        });
      for (const [key, child] of Object.entries(item)) if (key !== "locator") walk(child, scope);
    };
    walk(snapshot);
    const seen = new Set<string>();
    const elements: ReferenceCapture["elements"] = [];
    for (const candidate of candidates) {
      const key = JSON.stringify(candidate.locator);
      if (seen.has(key)) continue;
      seen.add(key);
      const target = resolveLocator(page, candidate.locator);
      const count = await target.count();
      const choices =
        count === 1
          ? [candidate]
          : count > 1
            ? await locatorAlternatives(page, candidate.locator)
            : [];
      for (const choice of choices) {
        const resolved = resolveLocator(page, choice.locator);
        if ((await resolved.count()) !== 1 || !(await resolved.isVisible())) continue;
        const element = await resolved.elementHandle();
        if (!element) continue;
        // Prefer a semantic ancestor over a positional fallback when it identifies
        // this exact target. The model never needs to reconstruct that scope.
        const observed = await element.evaluate((node) => {
          const tag = node.tagName.toLowerCase();
          const role =
            node.getAttribute("role") ??
            (
              {
                a: "link",
                button: "button",
                input: "textbox",
                select: "combobox",
                textarea: "textbox",
                img: "img",
                h1: "heading",
                h2: "heading",
                h3: "heading",
                h4: "heading",
                h5: "heading",
                h6: "heading",
                main: "main",
                nav: "navigation",
              } as Record<string, string>
            )[tag];
          const href = node instanceof HTMLAnchorElement ? node.href : undefined;
          const scopes: Array<{ role: string; name?: string }> = [];
          for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            const role =
              parent.getAttribute("role") ??
              (
                {
                  MAIN: "main",
                  ASIDE: "complementary",
                  NAV: "navigation",
                  FIELDSET: "group",
                } as Record<string, string>
              )[parent.tagName];
            if (!role) continue;
            const labelled = parent
              .getAttribute("aria-labelledby")
              ?.split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ")
              .trim();
            const name =
              parent.getAttribute("aria-label") ??
              labelled ??
              (parent.tagName === "FIELDSET"
                ? parent.querySelector("legend")?.textContent?.trim()
                : undefined);
            scopes.push({ role, ...(name ? { name } : {}) });
          }
          return { scopes, tag, role, href };
        });
        // Prefer the role collected through Playwright's accessibility snapshot.
        if (candidate.role) observed.role = candidate.role;
        else if (candidate.locator.strategy === "role") observed.role = candidate.locator.role;
        let compiled = choice.locator;
        for (const scope of observed.scopes) {
          const scoped: LocatorDefinition = {
            ...candidate.locator,
            within: {
              kind: "container",
              locator: { strategy: "role", ...scope, ...(scope.name ? { exact: true } : {}) },
            },
          };
          const target = resolveLocator(page, scoped);
          if (
            (await target.count()) === 1 &&
            (await target.evaluate((node, original) => node === original, element))
          ) {
            compiled = scoped;
            break;
          }
        }
        let elementRef: string | undefined;
        for (const [ref, entry] of this.entries) {
          // Reuse identifiers while the observed node and mapping remain unchanged.
          if (JSON.stringify(entry.locator) !== JSON.stringify(compiled)) continue;
          try {
            if (await element.evaluate((node, previous) => node === previous, entry.element))
              elementRef = ref;
          } catch {
            /* old document */
          }
          if (elementRef) break;
        }
        if (elementRef) await element.dispose();
        else {
          elementRef = `e${this.next++}`;
          this.entries.set(elementRef, {
            locator: compiled,
            element,
            label: choice.label,
            tag: observed.tag,
            ...(observed.role ? { role: observed.role } : {}),
            ...(observed.href ? { href: observed.href } : {}),
            ...(choice.context ? { context: choice.context } : {}),
          });
        }
        Object.assign(this.entries.get(elementRef)!, {
          label: choice.label,
          tag: observed.tag,
          role: observed.role,
          href: observed.href,
          context: choice.context,
        });
        if (count === 1) this.snapshotReferences.set(key, elementRef);
        if (!elements.some((item) => item.elementRef === elementRef))
          elements.push({
            elementRef,
            label: choice.label,
            tag: observed.tag,
            ...(observed.role ? { role: observed.role } : {}),
            ...(observed.href ? { href: observed.href } : {}),
            ...(choice.context ? { context: choice.context } : {}),
          });
        if (elements.length >= 128) return finish({ elements, truncated: true });
      }
    }
    return finish({ elements, truncated: false });
  }

  /** Keep long compiled locators on the host when an exact observed reference exists. */
  referenceSnapshot(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.referenceSnapshot(item));
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const ref = record.locator && this.snapshotReferences.get(JSON.stringify(record.locator));
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) =>
        key === "locator" && ref ? ["elementRef", ref] : [key, this.referenceSnapshot(child)],
      ),
    );
  }

  async close() {
    await this.revision.close();
    this.cached = undefined;
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.element.dispose()));
    this.entries.clear();
    this.snapshotReferences.clear();
  }
}

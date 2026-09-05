import type { Page } from "playwright";
import type { LocatorDefinition } from "../core/types.js";
import { collectOverview, toPageSnapshot } from "./overview.js";
import { resolveLocator } from "./locators.js";

/** Suggestions are observed, scoped and checked; they never authorize a replacement. */
export async function locatorAlternatives(page: Page, requested: LocatorDefinition) {
  const direct = resolveLocator(page, requested);
  if ((await direct.count()) > 1) {
    const structural: Array<{
      locator: LocatorDefinition;
      label: string;
      context?: string;
      matches: number;
    }> = [];
    for (let index = 0; index < (await direct.count()); index += 1) {
      const match = direct.nth(index);
      if (!(await match.isVisible())) continue;
      const observed = await match.evaluate((element) => {
        let selector: string | undefined;
        const testId = element.getAttribute("data-testid");
        if (testId) {
          const candidate = `[data-testid=${JSON.stringify(testId)}]`;
          if (document.querySelectorAll(candidate).length === 1) selector = candidate;
        }
        if (!selector && element.id) {
          const candidate = `#${CSS.escape(element.id)}`;
          if (document.querySelectorAll(candidate).length === 1) selector = candidate;
        }
        const parts: string[] = [];
        let current: Element | null = element;
        while (!selector && current) {
          const siblings: Element[] = [];
          if (current.parentElement) {
            for (const item of current.parentElement.children) {
              if (item.tagName === current.tagName) siblings.push(item);
            }
          } else {
            siblings.push(current);
          }
          parts.unshift(
            `${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`,
          );
          const candidate = parts.join(" > ");
          if (
            document.querySelectorAll(candidate).length === 1 &&
            document.querySelector(candidate) === element
          )
            selector = candidate;
          current = current.parentElement;
        }
        let context: string | undefined;
        current = element.parentElement;
        for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
          const label = current.matches("fieldset")
            ? current.querySelector(":scope > legend")
            : current.querySelector(
                ":scope > label, :scope > h1, :scope > h2, :scope > h3, :scope > h4",
              );
          const value =
            current.getAttribute("aria-label") ?? label?.textContent?.trim() ?? undefined;
          if (value && value !== element.textContent?.trim()) {
            context = value.replace(/\s+/g, " ");
            break;
          }
          const clone = current.cloneNode(true) as Element;
          for (const control of clone.querySelectorAll(
            "button, a, input, select, textarea, [role='button']",
          ))
            control.remove();
          const surrounding = clone.textContent?.trim().replace(/\s+/g, " ");
          if (surrounding && surrounding.length <= 160) {
            context = surrounding;
            break;
          }
        }
        return { selector: selector!, context };
      });
      structural.push({
        locator: { strategy: "css" as const, selector: observed.selector },
        label: requested.strategy === "role" ? (requested.name ?? requested.role) : "match",
        ...(observed.context === undefined ? {} : { context: observed.context }),
        matches: 1,
      });
    }
    if (structural.length > 0) return structural.slice(0, 8);
  }
  const snapshot = toPageSnapshot(await collectOverview(page));
  const candidates = [
    ...snapshot.headings.map((item) => ({
      locator: item.locator,
      label: item.text,
      role: "heading",
    })),
    ...snapshot.landmarks.map((item) => ({
      locator: item.locator,
      label: item.name ?? item.role,
      role: item.role,
    })),
    ...snapshot.regions.flatMap((region) =>
      region.controls.map((item) => ({
        locator: item.locator,
        label: item.name ?? item.label ?? "",
        role: item.role,
      })),
    ),
  ];
  const query =
    requested.strategy === "role"
      ? requested.name
      : requested.strategy === "text"
        ? requested.text
        : requested.strategy === "label"
          ? requested.label
          : "";
  const words = (query ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const ranked = candidates
    .filter(
      (item) => item.locator && (requested.strategy !== "role" || item.role === requested.role),
    )
    .map((item) => ({
      ...item,
      score: words.filter((word) => item.label.toLowerCase().includes(word)).length,
    }))
    .filter((item) => words.length === 0 || item.score > 0)
    .sort((a, b) => b.score - a.score);
  const result = [];
  const seen = new Set<string>();
  for (const candidate of ranked.slice(0, 16)) {
    const locator: LocatorDefinition = {
      ...candidate.locator!,
      ...(requested.within ? { within: requested.within } : {}),
    };
    const key = JSON.stringify(locator);
    if (seen.has(key)) continue;
    seen.add(key);
    const resolved = resolveLocator(page, locator);
    const matches = await resolved.count();
    if (matches === 1 && (await resolved.isVisible()))
      result.push({ locator, label: candidate.label, matches });
    if (result.length === 5) break;
  }
  return result;
}

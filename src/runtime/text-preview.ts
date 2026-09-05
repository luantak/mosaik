import type { Locator } from "playwright";
import type { LocatorDefinition } from "../core/types.js";

interface TextContentTarget {
  headingOnly: boolean;
  contentLocator?: LocatorDefinition;
}

// Keep browser code independent of helpers inserted by TypeScript transpilers.
const CONTENT_TARGET = String.raw`(element) => {
  const text = (node) => node.innerText?.trim().replace(/\s+/g, " ") ?? "";
  const headings = "h1,h2,h3,h4,h5,h6,[role=heading]";
  const heading = element.matches(headings) ? element : element.querySelector(headings);
  const title = heading && text(heading);
  if (!title || text(element) !== title) return { headingOnly: false };
  let container = element.parentElement;
  while (container && container !== document.body && text(container) === title) container = container.parentElement;
  if (!container || container === document.body || !text(container)) return { headingOnly: true };
  const parts = [];
  let current = container;
  while (current) {
    if (current.id && document.querySelectorAll("#" + CSS.escape(current.id)).length === 1) {
      parts.unshift("#" + CSS.escape(current.id));
      break;
    }
    const testId = current.getAttribute("data-testid");
    const testSelector = testId ? '[data-testid="' + CSS.escape(testId) + '"]' : undefined;
    if (testSelector && document.querySelectorAll(testSelector).length === 1) {
      parts.unshift(testSelector);
      break;
    }
    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement ? [...current.parentElement.children].filter((node) => node.tagName === current.tagName) : [current];
    parts.unshift(tag + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")");
    current = current.parentElement;
  }
  return { headingOnly: true, contentLocator: { strategy: "css", selector: parts.join(" > ") } };
}`;

/** Describe heading-only selections and suggest an observed structural container. */
export async function textContentTarget(locator: Locator): Promise<TextContentTarget> {
  return locator.evaluate((element, source) => {
    // The source is the fixed browser function above, never page/model input.
    return new Function("element", "return (" + source + ")(element)")(element);
  }, CONTENT_TARGET) as Promise<TextContentTarget>;
}

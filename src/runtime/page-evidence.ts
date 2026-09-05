import type { Page } from "playwright";

export interface PageNavigationEvidence {
  url: string;
  title: string;
  links: Array<{ href: string; title: string }>;
  truncated: boolean;
}

/** Read navigation from the actual execution page, including content links. */
export async function collectPageNavigationEvidence(page: Page): Promise<PageNavigationEvidence> {
  return page.evaluate(() => {
    const links: Array<{ href: string; title: string }> = [];
    const seen = new Set<string>();
    for (const element of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (!/^https?:$/.test(element.protocol)) continue;
      const title = (
        element.getAttribute("aria-label") ||
        element.innerText ||
        element.textContent ||
        ""
      ).trim();
      const key = `${element.href}\n${title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ href: element.href, title });
    }
    return {
      url: location.href,
      title: document.title,
      links: links.slice(0, 500),
      truncated: links.length > 500,
    };
  });
}

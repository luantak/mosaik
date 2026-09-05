import type { Browser, BrowserContext, Page } from "playwright";
import { collectOverview, toPageSnapshot } from "../../runtime/overview.js";
import { openAgentBrowser, sharedAgentPage } from "../../runtime/session.js";

/** Read-only planning observations on the invocation page when available. */
export function createNavigationObserver(input: {
  startUrl: string;
  browser?: Browser;
  observedUrls?: string[];
}) {
  const observedUrls = new Set([navigationUrl(input.startUrl)]);
  for (const url of input.observedUrls ?? []) {
    try {
      observedUrls.add(navigationUrl(url));
    } catch {
      /* Ignore unsupported evidence links. */
    }
  }
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let firstBrowserActionAt: number | undefined;
  return {
    async inspect(url = input.startUrl) {
      const target = navigationUrl(url);
      if (!observedUrls.has(target)) {
        throw new Error(
          "Inspect only the start URL or a link returned by inspectNavigation; do not guess destinations.",
        );
      }
      if (!page) {
        browser = input.browser ?? (await openAgentBrowser());
        page = await sharedAgentPage(browser);
        if (!page) {
          context = await browser.newContext();
          page = await context.newPage();
        }
      }
      if (page.url() !== target) {
        firstBrowserActionAt ??= Date.now();
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 });
      }
      const overview = await collectOverview(page);
      const baseUrl = await page.evaluate(() => document.baseURI);
      const links = overview.interactive.flatMap((control) => {
        if (!control.visible || !control.href) return [];
        try {
          const href = navigationUrl(new URL(control.href, baseUrl).href);
          observedUrls.add(href);
          return [
            {
              title: control.name ?? control.text ?? "",
              href,
              locator: {
                strategy: "role" as const,
                role: control.role ?? "link",
                attribute: {
                  name: "href",
                  value: { kind: "literal" as const, value: control.href },
                },
              },
            },
          ];
        } catch {
          return [];
        }
      });
      const unique = [...new Map(links.map((link) => [JSON.stringify(link), link])).values()];
      return {
        purpose: "discovery-observation" as const,
        firstBrowserActionAt,
        url: overview.url,
        title: overview.title,
        headings: overview.headings,
        landmarks: toPageSnapshot(overview).landmarks,
        links: unique,
      };
    },
    async close() {
      try {
        await context?.close();
      } finally {
        if (!input.browser) await browser?.close();
      }
    },
  };
}

function navigationUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Navigation observations require an HTTP(S) URL without embedded credentials");
  }
  return url.href;
}

/** Only structured browser evidence supplies recovery destinations, never model prose. */
export function recoveryNavigationUrls(feedback: string | undefined): string[] {
  if (feedback === undefined) return [];
  try {
    const parsed = JSON.parse(feedback);
    const navigation = parsed.observedNavigation ?? parsed.executionEvidence?.pageNavigation;
    if (!navigation || typeof navigation !== "object") return [];
    const urls = [
      navigation.url,
      ...(Array.isArray(navigation.links)
        ? navigation.links.map((link: { href?: unknown } | null) => link?.href)
        : []),
    ];
    return [
      ...new Set(
        urls.flatMap((url) => {
          if (typeof url !== "string") return [];
          try {
            return [navigationUrl(url)];
          } catch {
            return [];
          }
        }),
      ),
    ];
  } catch {
    return [];
  }
}

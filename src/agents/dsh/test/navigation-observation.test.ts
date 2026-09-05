import assert from "node:assert/strict";
import { test } from "vitest";
import { createNavigationObserver, recoveryNavigationUrls } from "../navigation-observation.js";
import { startFixtureServer, withBrowser } from "../../../runtime/index.js";

test("planning observations follow visible links with document base URLs and keep browser state separate", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: '<base href="/references/"><main><a href="guide">Guide</a><a href="guide">Guide</a><a href="mailto:help@example.com">Email</a><a hidden href="secret">Hidden</a></main>',
    },
    "/references/guide": { html: '<main><h1>Guide</h1><a href="/">Home</a></main>' },
  });
  try {
    await withBrowser(async (browser) => {
      const executionContext = await browser.newContext();
      const executionPage = await executionContext.newPage();
      const observer = createNavigationObserver({ browser, startUrl: fixture.url });
      try {
        await assert.rejects(
          observer.inspect(new URL("/guessed", fixture.url).href),
          /do not guess/,
        );
        const first = await observer.inspect();
        assert.equal(first.purpose, "discovery-observation");
        assert.deepEqual(first.links, [
          {
            title: "Guide",
            href: new URL("/references/guide", fixture.url).href,
            locator: {
              strategy: "role",
              role: "link",
              attribute: { name: "href", value: { kind: "literal", value: "guide" } },
            },
          },
        ]);
        const guide = await observer.inspect(first.links[0]!.href);
        assert.equal(guide.headings[0]?.text, "Guide");
        assert.equal(executionPage.url(), "about:blank");
        await assert.rejects(observer.inspect("javascript:alert(1)"), /HTTP/);
        await assert.rejects(
          observer.inspect(new URL("/references/secret", fixture.url).href),
          /do not guess/,
        );
      } finally {
        await observer.close();
      }
      assert.equal(browser.contexts().length, 1);
      await executionContext.close();
    });
  } finally {
    await fixture.close();
  }
});

test("recovery navigation uses structured browser links rather than URLs in model feedback", () => {
  const urls = recoveryNavigationUrls(
    JSON.stringify({
      missingOutcome: "Inspect https://invented.example/guess",
      observedNavigation: {
        url: "https://example.com/",
        links: [{ href: "https://example.com/reference" }, { href: "javascript:alert(1)" }, null],
      },
      executionEvidence: { truncated: true, prefix: "partial JSON" },
    }),
  );
  assert.deepEqual(urls, ["https://example.com/", "https://example.com/reference"]);
  assert.deepEqual(recoveryNavigationUrls("not JSON"), []);
});

test("an observer accepts recovery evidence without revisiting the start page", async () => {
  const fixture = await startFixtureServer({
    "/reference": { html: "<main><h1>Reference</h1></main>" },
  });
  try {
    await withBrowser(async (browser) => {
      const destination = new URL("/reference", fixture.url).href;
      const observer = createNavigationObserver({
        browser,
        startUrl: new URL("/unavailable", fixture.url).href,
        observedUrls: [destination],
      });
      try {
        assert.equal((await observer.inspect(destination)).headings[0]?.text, "Reference");
      } finally {
        await observer.close();
      }
    });
  } finally {
    await fixture.close();
  }
});

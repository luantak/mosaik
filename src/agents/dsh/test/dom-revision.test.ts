import assert from "node:assert/strict";
import test from "node:test";
import { withBrowser } from "../../../runtime/index.js";
import { DomRevision } from "../dom-revision.js";

test("document revision tracks otherwise invisible DOM changes and disables reuse for shadow roots", async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    const revision = new DomRevision();
    try {
      await page.setContent("<main><span>Text</span></main>");
      const first = await revision.read(page);
      assert.ok(first);
      assert.equal(await revision.read(page), first);
      await page.locator("span").evaluate((node) => {
        node.firstChild!.textContent = "Other";
      });
      const changed = await revision.read(page);
      assert.notEqual(changed, first);
      await page.locator("main").evaluate((node) => {
        node.attachShadow({ mode: "open" }).innerHTML = "<button>Shadow</button>";
      });
      assert.equal(await revision.read(page), null);
      await page.setContent("<main>New document</main>");
      assert.notEqual(await revision.read(page), changed);
    } finally {
      await revision.close();
      await page.close();
    }
  });
});

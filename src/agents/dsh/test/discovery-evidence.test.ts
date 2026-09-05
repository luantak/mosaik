import { startFixtureServer, withBrowser } from "../../../runtime/index.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDiscoveryEvidence, discoveryEvidenceIsCurrent } from "../discovery-evidence.js";

test("discovery evidence preserves full observed outputs without claiming automation execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-observations-"));
  try {
    await mkdir(join(root, "group"));
    const observations = [
      { name: "readReference", outputs: { reference: "Full instructions ".repeat(1000) } },
    ];
    await writeFile(
      join(root, "group", "mosaik-observations.json"),
      JSON.stringify({ observations }),
    );
    const result = await readDiscoveryEvidence(root);
    assert.equal(result.origin, "discovery");
    assert.deepEqual(result.discoveryObservations, observations);
    assert.deepEqual(result.actionCalls, []);
    assert.equal(result.value, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same URL does not preserve a completion after page state changes", async () => {
  const fixture = await startFixtureServer({ "/": { html: '<main data-state="ready"></main>' } });
  try {
    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.goto(fixture.url);
      const evidence = {
        success: true,
        logs: [],
        actionCalls: [],
        discoveryObservations: [
          {
            page: fixture.url,
            completion: {
              kind: "attribute",
              locator: { strategy: "role", role: "main" },
              name: "data-state",
              value: "ready",
            },
          },
        ],
      };
      assert.equal(await discoveryEvidenceIsCurrent(page, evidence), true);
      await page.locator("main").evaluate((el) => el.setAttribute("data-state", "closed"));
      assert.equal(await discoveryEvidenceIsCurrent(page, evidence), false);
      assert.equal(await discoveryEvidenceIsCurrent(undefined, evidence), false);
      await page.close();
    });
  } finally {
    await fixture.close();
  }
});

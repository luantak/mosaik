import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { validateAutomation } from "../../automations/validate.js";
import {
  CATALOGUE_RECORDS,
  expectedCatalogueRecords,
  seedCatalogueAutomation,
  startCatalogueFixture,
} from "../catalogue.js";

test("catalogue pagination and filters cover the independent 1,200-record oracle", async () => {
  assert.equal(CATALOGUE_RECORDS.length, 1_200);
  const fixture = await startCatalogueFixture();
  try {
    let url: string | undefined = `${fixture.url}?category=all`;
    const seen = new Set<string>();
    let references = 0;
    let pages = 0;
    while (url) {
      assert.ok(pages++ < 40, "pagination must terminate");
      const response: Response = await fetch(url);
      assert.equal(response.status, 200);
      const html = await response.text();
      const ids = [...html.matchAll(/class="catalogue-item" data-id="([^"]+)"/g)].map(
        (match) => match[1]!,
      );
      assert.ok(ids.length <= 40);
      references += ids.length;
      for (const id of ids) seen.add(id);
      url = html.match(/rel="next" href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
      if (!url) assert.match(html, /class="end-of-catalogue"/);
    }
    assert.deepEqual(
      [...seen],
      CATALOGUE_RECORDS.map((record) => record.id),
    );
    assert.ok(references > seen.size, "pages must overlap for deduplication tests");
    assert.equal(expectedCatalogueRecords(fixture.origin, "books").length, 400);
    const books = await (await fetch(`${fixture.url}?category=books`)).text();
    const booksIds = [...books.matchAll(/class="catalogue-item" data-id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      booksIds,
      expectedCatalogueRecords(fixture.origin, "books", 40).map((record) => record.id),
    );
    const filtered = await (await fetch(`${fixture.url}?category=books&q=0001`)).text();
    assert.equal([...filtered.matchAll(/class="catalogue-item"/g)].length, 1);
    const empty = await (await fetch(`${fixture.url}?category=missing`)).text();
    assert.match(empty, /class="no-results"/);
    assert.match(empty, /class="end-of-catalogue"/);
  } finally {
    await fixture.close();
  }
});

test("fixture failures and layout variations leave the expected data unchanged", async () => {
  const fixture = await startCatalogueFixture();
  try {
    const id = CATALOGUE_RECORDS[0]!.id;
    const url = `${fixture.origin}/record/${id}`;
    fixture.controls.transientFailures.set(id, 2);
    assert.equal((await fetch(url)).status, 503);
    assert.equal((await fetch(url)).status, 503);
    assert.match(await (await fetch(url)).text(), /class="record"/);
    fixture.controls.newLayoutIds.add(id);
    assert.match(await (await fetch(url)).text(), /class="entry"/);
    fixture.controls.malformedIds.add(id);
    assert.match(await (await fetch(url)).text(), /data-title=""/);
    assert.equal(expectedCatalogueRecords(fixture.origin)[0]!.title, "Catalogue item 0001");
    fixture.controls.unavailableIds.add(id);
    assert.equal((await fetch(url)).status, 503);
    fixture.controls.omittedIds.add(id);
    assert.doesNotMatch(await (await fetch(fixture.url)).text(), new RegExp(`data-id="${id}"`));
    assert.equal(fixture.requests.details.get(id), 6);
  } finally {
    await fixture.close();
  }
});

test("fixture setup saves parameterized TypeScript and preserves an existing edited library", async () => {
  const project = await mkdtemp(join(tmpdir(), "mosaik-catalogue-seed-"));
  try {
    const seeded = await seedCatalogueAutomation(project, "http://127.0.0.1:4318");
    assert.equal(seeded.created, true);
    assert.equal(seeded.actions.length, 3);
    validateAutomation(seeded.automation.source, {
      actionNames: seeded.actions.map((action) => action.name),
    });
    assert.match(seeded.automation.source, /ctx\.batch\.run/);
    assert.match(seeded.automation.source, /Hand-authored fixture seed/);
    assert.deepEqual(seeded.automation.inputs, {
      category: { type: "string" },
      requestedCount: { type: "number" },
    });
    const edited = {
      ...seeded.automation,
      source: seeded.automation.source.replace('key: "records"', 'key: "retained-records"'),
    };
    await seeded.store.saveAutomation(edited);
    const second = await seedCatalogueAutomation(project, "http://127.0.0.1:4318");
    assert.equal(second.created, false);
    assert.match(second.automation.source, /retained-records/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

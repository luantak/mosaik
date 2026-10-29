import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createCompositionSession, unwrapCodeModeValue } from "../../capabilities/code-mode.js";
import { runCompositionCode } from "../../agents/dsh/composition-tools.js";
import { seedCatalogueAutomation } from "../../fixtures/catalogue.js";

test("composition tools validate and persist durable collection callbacks as per-item work", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-batch-composition-"));
  try {
    const { store, automation, siteId } = await seedCatalogueAutomation(
      root,
      "http://127.0.0.1:4318",
    );
    const task =
      "Collect all catalogue records from each detail page with id, title, category and sourceUrl";
    const session = createCompositionSession({
      registry: store.siteActions,
      suppliedInputs: { category: "books", requestedCount: 10 },
      task,
      discover: async () => {
        throw new Error("All capabilities already exist");
      },
      saveAutomation: (value) => store.saveAutomation(value),
    });
    await session.list(siteId);
    const needs = [
      {
        name: "openPage",
        stage: "listing",
        cardinality: "once",
        intent: "Open a catalogue listing URL",
      },
      {
        name: "listRecords",
        stage: "references",
        cardinality: "once",
        intent: "Collect item references",
        after: ["listing"],
      },
      {
        name: "openPage",
        stage: "detail",
        cardinality: "per-item",
        intent: "Open each item detail page",
        after: ["references"],
      },
      {
        name: "readRecord",
        stage: "extract",
        cardinality: "per-item",
        intent: "Read each record from its detail page",
        after: ["detail"],
      },
    ];
    const result = await runCompositionCode(
      session,
      `return await tools.finishComposition(${JSON.stringify({ siteId, task, needs, automationId: "generated-collection", automationSource: automation.source })});`,
    );
    const terminal = unwrapCodeModeValue(result.value) as { status: string };
    assert.equal(terminal.status, "composed");
    const saved = await store.getAutomation(siteId, "generated-collection");
    assert.equal(saved?.durable, true);
    assert.match(saved!.source, /ctx\.batch\.run/);
    assert.equal(saved?.dependencies?.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

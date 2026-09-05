import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineAction, string } from "../../capabilities/index.js";
import { extractText, fill, inputRef, label, testId } from "../../core/index.js";
import { automationDependencies } from "../../automations/index.js";
import { openFileRepository } from "../repository.js";

async function withRepository(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mosaik-persist-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("actions and automations survive a new repository instance", async () => {
  await withRepository(async (root) => {
    const action = defineAction({
      id: "shop.get-price",
      siteId: "shop.example.com",
      name: "getPrice",
      description: "Read the product price on the current page",
      outputs: { price: string() },
      safety: "read-only",
      steps: [
        extractText({
          id: "price",
          locator: testId("price"),
          output: "price",
          safety: "read-only",
        }),
      ],
    });
    const store = openFileRepository(root);
    await store.siteActions.save(action);
    await store.saveAutomation({
      id: "read-price",
      siteId: action.siteId,
      source: "export default defineAutomation(async (ctx) => ctx.actions.getPrice());",
      version: 1,
      dependencies: automationDependencies([action]),
    });

    const restarted = openFileRepository(root);
    assert.deepEqual(await restarted.siteActions.get(action.id), action);
    assert.deepEqual(await restarted.siteActions.listSites(), [action.siteId]);
    assert.equal((await restarted.getAutomation(action.siteId, "read-price"))?.version, 1);
    assert.deepEqual(await restarted.listAutomationIds(action.siteId), ["read-price"]);
  });
});

test("action updates reject a stale version", async () => {
  await withRepository(async (root) => {
    const action = defineAction({
      id: "shop.search-products",
      siteId: "shop.example.com",
      name: "searchProducts",
      description: "Search the product catalog",
      inputs: { query: string() },
      safety: "browser-local",
      steps: [
        fill({
          id: "query",
          locator: label("Search"),
          value: inputRef("query"),
          safety: "browser-local",
        }),
      ],
    });
    const first = openFileRepository(root);
    const second = openFileRepository(root);
    await first.siteActions.save(action);
    const next = defineAction({ ...action, steps: action.implementation.steps, version: 2 });

    assert.equal(
      (
        await first.siteActions.updateActionIfVersion({
          siteId: action.siteId,
          actionId: action.id,
          expectedVersion: 1,
          next,
        })
      ).updated,
      true,
    );
    const stale = await second.siteActions.updateActionIfVersion({
      siteId: action.siteId,
      actionId: action.id,
      expectedVersion: 1,
      next,
    });
    assert.equal(stale.updated, false);
    assert.equal(stale.reason, "version-conflict");
  });
});

test("clearing learned data preserves authentication records", async () => {
  await withRepository(async (root) => {
    const store = openFileRepository(root);
    await store.saveAuthAutomation({
      id: "auth-example.com-login",
      loginUrl: "https://example.com/login",
      steps: [],
      successCondition: {
        loginUrl: "https://example.com/login",
        targetUrl: "https://example.com/account",
        requireAuthFormAbsent: true,
        confidence: "high",
        reason: "Account page loaded",
      },
      version: 1,
    });
    assert.deepEqual(await store.clearLearnedLibrary(), { actions: 0, automations: 0 });
    assert.ok(await store.getAuthAutomation("auth-example.com-login"));
  });
});

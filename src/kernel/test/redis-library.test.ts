import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { defineAction, string } from "../../capabilities/index.js";
import { extractText, role } from "../../core/index.js";
import { openRedisLibraryBackend } from "../redis-library.js";

const redisUrl =
  process.env.MOSAIK_TEST_REDIS_URL ?? process.env.MOSAIK_LIBRARY_URL ?? process.env.REDIS_URL;

test(
  "Redis library stores records and rejects stale or conflicting writes",
  { skip: redisUrl === undefined },
  async () => {
    const backend = await openRedisLibraryBackend({
      url: redisUrl!,
      namespace: `mosaik:test:${randomUUID()}`,
    });
    try {
      const action = defineAction({
        id: "example.extract-heading",
        siteId: "example.com",
        name: "extractHeading",
        description: "Read the page heading",
        safety: "read-only",
        outputs: { heading: string() },
        steps: [
          extractText({
            id: "heading",
            locator: role("heading"),
            output: "heading",
            safety: "read-only",
          }),
        ],
      });
      assert.equal(await backend.writeAction(action, undefined), "stored");
      assert.equal(await backend.writeAction(action, undefined), "unchanged");
      assert.equal(
        await backend.writeAction({ ...action, id: "example.other-heading" }, undefined),
        "name-conflict",
      );
      assert.equal((await backend.findAction(action.id))?.name, "extractHeading");
      assert.deepEqual(await backend.listSites(), ["example.com"]);

      const versionTwo = { ...action, version: 2, description: "Read the primary page heading" };
      assert.equal(await backend.writeAction(versionTwo, 1), "stored");
      assert.equal(await backend.writeAction({ ...versionTwo, version: 3 }, 1), "conflict");

      const automation = {
        id: "read-heading",
        siteId: "example.com",
        source: "export default defineAutomation(async () => ({}));",
        version: 1,
      };
      assert.equal(await backend.writeAutomation(automation, undefined), "stored");
      assert.equal(await backend.writeAutomation(automation, undefined), "unchanged");
      assert.equal(
        await backend.writeAutomation(
          {
            ...automation,
            source: "export default defineAutomation(async () => ({ changed: true }));",
          },
          1,
        ),
        "conflict",
      );
      assert.equal((await backend.getAutomation("example.com", automation.id))?.version, 1);

      await backend.clear();
      assert.deepEqual(await backend.listSites(), []);
    } finally {
      await backend.close();
    }
  },
);

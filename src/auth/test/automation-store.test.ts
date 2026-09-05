import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  loadProfileAuthAutomation,
  profileAuthAutomationsPath,
  saveProfileAuthAutomation,
} from "../automation-store.js";
import type { AuthSuccessCondition } from "../types.js";

test("legacy profile auth checks remain readable for repository migration", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "mosaik-auth-automation-"));
  const profileDirectory = join(temporaryDirectory, "profile");
  const condition: AuthSuccessCondition = {
    loginUrl: "http://localhost:3000/login",
    targetUrl: "http://localhost:3000/dashboard",
    requireAuthFormAbsent: true,
    confidence: "high",
    reason: "A user menu is visible",
    marker: {
      candidateId: "marker-1",
      description: 'button "User menu"',
      locator: { strategy: "test-id", testId: "user-menu" },
    },
  };

  try {
    assert.equal(await loadProfileAuthAutomation(profileDirectory, condition.loginUrl), undefined);
    await saveProfileAuthAutomation(profileDirectory, condition);
    assert.deepEqual(
      await loadProfileAuthAutomation(profileDirectory, `${condition.loginUrl}?next=%2Fsettings`),
      condition,
    );

    const path = profileAuthAutomationsPath(profileDirectory);
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes(condition.targetUrl), true);
    assert.equal(raw.includes("user-menu"), true);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

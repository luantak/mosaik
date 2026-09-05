import assert from "node:assert/strict";
import { test } from "vitest";
import { compile } from "../compile.js";
import { click, label, navigate } from "../dsl.js";
import {
  acceptRepairedVersion,
  markVerified,
  promoteVerificationOnSuccess,
  recordFailedRun,
  recordSuccessfulRun,
} from "../verification.js";

function sample(verification?: { status: "unverified" | "verified" | "invalid" }) {
  return compile({
    id: "checkout",
    version: 1,
    ...(verification === undefined ? {} : { verification }),
    actions: [
      {
        id: "checkout/main",
        name: "checkout",
        steps: [
          navigate({ id: "open", url: "http://127.0.0.1/", safety: "browser-local" }),
          click({ id: "go", locator: label("Continue"), safety: "browser-local" }),
        ],
      },
    ],
  });
}

test("unverified success promotes to verified and keeps discovery evidence", () => {
  const automation = {
    ...sample({ status: "unverified" }),
    verification: { status: "unverified" as const, discoveryGoalReached: true },
  };
  const promoted = promoteVerificationOnSuccess(automation);
  assert.equal(promoted.changed, true);
  assert.equal(promoted.from, "unverified");
  assert.equal(promoted.to, "verified");
  assert.equal(promoted.automation.verification?.status, "verified");
  assert.equal(promoted.automation.verification?.discoveryGoalReached, true);
  assert.equal(automation.verification.status, "unverified");
});

test("verified and unannotated automations stay put on success", () => {
  const verified = promoteVerificationOnSuccess(markVerified(sample({ status: "unverified" })));
  assert.equal(verified.changed, false);
  assert.equal(verified.automation.verification?.status, "verified");

  const authored = promoteVerificationOnSuccess(sample());
  assert.equal(authored.changed, false);
  assert.equal(authored.automation.verification, undefined);
});

test("accepted repair bumps version and returns to unverified", () => {
  const verified = markVerified(sample({ status: "unverified" }));
  const next = acceptRepairedVersion(verified);
  assert.equal(next.version, 2);
  assert.equal(next.verification?.status, "unverified");
  assert.equal(verified.version, 1);
  assert.equal(verified.verification?.status, "verified");
});

test("successful and failed runs accumulate facts without a confidence state", () => {
  const first = recordSuccessfulRun(sample({ status: "unverified" }), 1_000);
  const second = recordSuccessfulRun(first, 2_000);
  const failed = recordFailedRun(second, 3_000);
  assert.equal(failed.verification?.status, "unverified");
  assert.deepEqual(failed.runStats, {
    successfulRuns: 2,
    failedRuns: 1,
    lastSuccessAt: 2_000,
    lastFailureAt: 3_000,
  });
  assert.equal(first.runStats?.successfulRuns, 1);
});

test("repair archives the previous version's run counts", () => {
  const used = recordSuccessfulRun(
    recordSuccessfulRun(markVerified(sample({ status: "unverified" })), 10),
    20,
  );
  const next = acceptRepairedVersion(used);
  assert.equal(next.version, 2);
  assert.equal(next.verification?.status, "unverified");
  assert.equal(next.runStats, undefined);
  assert.deepEqual(next.versionHistory, [
    {
      version: 1,
      stats: { successfulRuns: 2, failedRuns: 0, lastSuccessAt: 20 },
    },
  ]);
  assert.equal(used.version, 1);
  assert.equal(used.runStats?.successfulRuns, 2);
});

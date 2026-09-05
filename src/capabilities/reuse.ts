import type { SiteActionRegistry } from "./lookup.js";

export async function recordSuccessfulSiteActionReuse(
  registry: SiteActionRegistry,
  actionId: string,
  now = Date.now(),
  expectedVersion?: number,
  conditionChecked = false,
  promote = true,
): Promise<void> {
  const current = await registry.get(actionId);
  if (
    current === undefined ||
    (expectedVersion !== undefined && current.version !== expectedVersion)
  )
    return;
  const stats = current.runStats ?? { successfulRuns: 0, failedRuns: 0 };
  await registry.updateActionIfVersion({
    siteId: current.siteId,
    actionId: current.id,
    expectedVersion: current.version,
    next: {
      ...current,
      verificationBasis: conditionChecked ? "condition-checked" : "legacy-execution",
      verification:
        current.verification === "unverified" && promote ? "verified" : current.verification,
      runStats: {
        successfulRuns: stats.successfulRuns + 1,
        failedRuns: stats.failedRuns,
        lastSuccessAt: now,
        ...(stats.lastFailureAt === undefined ? {} : { lastFailureAt: stats.lastFailureAt }),
      },
    },
  });
}

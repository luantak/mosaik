import type {
  Automation,
  AutomationVerificationStatus,
  AutomationVersionRecord,
  AutomationVersionStats,
} from "./types.js";

export function emptyRunStats(): AutomationVersionStats {
  return { successfulRuns: 0, failedRuns: 0 };
}

export function markVerified(automation: Automation): Automation {
  const next = structuredClone(automation);
  next.verification = {
    ...next.verification,
    status: "verified",
  };
  return next;
}

export function acceptRepairedVersion(automation: Automation): Automation {
  const next = structuredClone(automation);
  const archived = archiveCurrentVersion(next);
  next.version = automation.version + 1;
  next.verification = { status: "unverified" };
  if (archived.length === 0) {
    delete next.versionHistory;
  } else {
    next.versionHistory = archived;
  }
  delete next.runStats;
  return next;
}

export function recordSuccessfulRun(automation: Automation, now = Date.now()): Automation {
  const next = structuredClone(automation);
  const current = next.runStats ?? emptyRunStats();
  next.runStats = {
    successfulRuns: current.successfulRuns + 1,
    failedRuns: current.failedRuns,
    lastSuccessAt: now,
    ...(current.lastFailureAt === undefined ? {} : { lastFailureAt: current.lastFailureAt }),
  };
  return next;
}

export function recordFailedRun(automation: Automation, now = Date.now()): Automation {
  const next = structuredClone(automation);
  const current = next.runStats ?? emptyRunStats();
  next.runStats = {
    successfulRuns: current.successfulRuns,
    failedRuns: current.failedRuns + 1,
    lastFailureAt: now,
    ...(current.lastSuccessAt === undefined ? {} : { lastSuccessAt: current.lastSuccessAt }),
  };
  return next;
}

export function promoteVerificationOnSuccess(automation: Automation): {
  automation: Automation;
  changed: boolean;
  from?: AutomationVerificationStatus;
  to?: AutomationVerificationStatus;
} {
  if (automation.verification?.status !== "unverified") {
    return { automation, changed: false };
  }
  return {
    automation: markVerified(automation),
    changed: true,
    from: "unverified",
    to: "verified",
  };
}

function archiveCurrentVersion(automation: Automation): AutomationVersionRecord[] {
  const history = [...(automation.versionHistory ?? [])];
  const stats = automation.runStats;
  if (stats === undefined) return history;
  return [
    ...history.filter((entry) => entry.version !== automation.version),
    { version: automation.version, stats: structuredClone(stats) },
  ];
}

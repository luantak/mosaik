import type { AutomationFailure, FailureClassification } from "./types.js";

export function classify(failure: AutomationFailure): FailureClassification {
  const type = failure.error.type;
  const status = failure.evidence?.httpStatus;
  const similarNames = failure.evidence?.similarNames ?? [];

  if (type === "external-service-error" || (status !== undefined && status >= 500)) {
    return {
      category: "infra",
      confidence: 0.9,
      reason:
        status === undefined
          ? "Network or upstream service failed"
          : `HTTP ${status} is an infrastructure failure, not a locator problem`,
    };
  }

  if (type === "navigation-failed") {
    return {
      category: status !== undefined && status >= 500 ? "infra" : "retryable",
      confidence: 0.8,
      reason: "Navigation failed; this slice does not repair navigation targets",
    };
  }

  if (type === "authentication-failed") {
    return { category: "auth", confidence: 0.8, reason: "Authentication failed" };
  }

  if (type === "locator-not-found" || type === "locator-ambiguous") {
    return {
      category: "repairable-browser",
      confidence: 0.85,
      reason:
        type === "locator-not-found"
          ? "Locator matched nothing"
          : "Locator matched more than one element",
    };
  }

  if (type === "timeout") {
    const drifted =
      (failure.evidence?.matchCount === 0 && similarNames.length > 0) || similarNames.length > 0;
    if (drifted) {
      return {
        category: "repairable-browser",
        confidence: 0.7,
        reason: "Timeout with locator-drift evidence",
      };
    }
    return {
      category: "unknown",
      confidence: 0.4,
      reason: "Timeout without locator-drift evidence",
    };
  }

  return {
    category: "unknown",
    confidence: 0.3,
    reason: `Failure type ${type} is not an autonomous locator repair`,
  };
}

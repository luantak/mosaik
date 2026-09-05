import type { Step, StepSafety } from "../core/index.js";

export type RepairAutonomy = "autonomous" | "autonomous-validated" | "propose-only";

export interface RepairPolicy {
  autonomy: RepairAutonomy;
  mayValidateLive: boolean;
}

export function repairPolicyFor(safety: StepSafety): RepairPolicy {
  if (safety === "read-only") {
    return { autonomy: "autonomous", mayValidateLive: true };
  }
  if (safety === "browser-local") {
    return { autonomy: "autonomous-validated", mayValidateLive: true };
  }
  return { autonomy: "propose-only", mayValidateLive: false };
}

export function mayValidateStepLive(step: Step): boolean {
  return repairPolicyFor(step.safety).mayValidateLive;
}

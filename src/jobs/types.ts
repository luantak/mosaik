import type { ComposedAutomation } from "../automations/types.js";
import type { SiteActionDefinition } from "../capabilities/types.js";

/** These checks describe a collection, not whether its contents answer a semantic question. */
export interface BatchAcceptance {
  requiredFields: string[];
  idField: string;
  sourceUrlField: string;
  requestedCount?: number;
  requireExhaustion?: boolean;
  allowEmpty?: boolean;
}

export interface BatchConfiguration {
  key: string;
  initialCursor: string;
  acceptance: BatchAcceptance;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  limits?: {
    maxItems?: number;
    maxPages?: number;
    maxResultBytes?: number;
    maxTotalBytes?: number;
    maxPageItems?: number;
    maxInputBytes?: number;
  };
}

export interface BatchItem {
  id: string;
  input: Record<string, unknown>;
}

export interface BatchPage {
  items: BatchItem[];
  nextCursor: string | null;
  exhausted: boolean;
}

export interface ItemWork extends BatchItem {
  kind: "item";
  attempt: number;
}

export interface PageWork {
  kind: "page";
  cursor: string;
  attempt: number;
}

export type BatchWork = ItemWork | PageWork;
export type NextWork = BatchWork | { kind: "wait"; delayMs: number } | { kind: "done" };

export interface JobMetadata {
  automation: ComposedAutomation;
  input: Record<string, unknown>;
  startUrl?: string;
  runtimeFingerprint: string;
  dependencies: Record<string, string>;
}

export interface AcceptedJobRepair {
  actionId: string;
  fromFingerprint: string;
  toFingerprint: string;
  fromVersion: number;
  toVersion: number;
  /** An accepted implementation can be restored if registry persistence was interrupted. */
  action?: SiteActionDefinition;
  evidence?: string;
  acceptedAt?: string;
}

export type JobTermination =
  | "requested-count"
  | "source-exhausted"
  | "page-failed"
  | "limit"
  | "interrupted"
  | "error";

export interface JobSummary {
  id: string;
  directory: string;
  status: "running" | "complete" | "incomplete" | "failed" | "interrupted";
  collected: number;
  pending: number;
  failed: number;
  failedPages: number;
  pages: number;
  attempts: number;
  termination: JobTermination | null;
  sourceExhausted: boolean;
  requestedCount?: number;
  outputPath: string;
  failuresPath: string;
  databasePath: string;
  repairs: number;
  reason?: string;
}

export interface JobInspection {
  metadata: JobMetadata;
  configuration?: BatchConfiguration;
  summary: JobSummary;
  acceptedRepairs: AcceptedJobRepair[];
}

/** In-process test injection; no environment variable enables fault injection in production. */
export type JobPersistenceBoundary = (
  operation: "configure" | "attempt" | "page" | "commit" | "failure" | "repair" | "finish",
  phase: "before-commit" | "after-commit",
) => void;

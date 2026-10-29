import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  opendirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AcceptedJobRepair,
  BatchConfiguration,
  BatchPage,
  BatchWork,
  ItemWork,
  JobInspection,
  JobMetadata,
  JobPersistenceBoundary,
  JobSummary,
  JobTermination,
  NextWork,
  PageWork,
} from "./types.js";

const FORMAT_VERSION = 1;
const DEFAULT_LIMITS = {
  maxItems: 100_000,
  maxPages: 10_000,
  maxResultBytes: 131_072,
  maxTotalBytes: 268_435_456,
  maxPageItems: 500,
  maxInputBytes: 16_384,
};
const DEFAULT_RETRY = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 10_000 };
const MAX_CONFIGURATION_BYTES = 65_536;
const MAX_METADATA_BYTES = 2_097_152;
const MAX_ERROR_BYTES = 4_096;
const MAX_REPAIR_HISTORY_BYTES = 8_388_608;

interface Owner {
  token: string;
  pid: number;
  host: string;
}

interface State {
  status: JobSummary["status"];
  termination: JobTermination | null;
  sourceExhausted: boolean;
  reason?: string;
}

interface StoredWork {
  attempts: number;
  next_attempt_at: number;
  inflight: number;
  state: "pending" | "completed" | "failed";
}

interface StoredItem extends StoredWork {
  id: string;
  input: string;
}

interface StoredPage extends StoredWork {
  cursor: string;
}

/** A local-filesystem journal. SQLite is authoritative; NDJSON files are replaceable snapshots. */
export class DurableJob {
  readonly directory: string;
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly owner: Owner = { token: randomUUID(), pid: process.pid, host: hostname() };
  private closed = false;
  private readonly boundary: JobPersistenceBoundary | undefined;
  private readonly exportingOnly: boolean;

  static open(
    directory: string,
    metadata: JobMetadata,
    options: { resume?: boolean; boundary?: JobPersistenceBoundary } = {},
  ): DurableJob {
    return new DurableJob(directory, metadata, options);
  }

  /** Export a stopped job without charging retries or changing its recovery state. */
  static exportExisting(directory: string): JobSummary {
    const { metadata } = inspectJob(directory);
    const job = new DurableJob(directory, metadata, { resume: true, exportOnly: true });
    try {
      return job.export();
    } finally {
      job.close();
    }
  }

  private constructor(
    directory: string,
    metadata: JobMetadata,
    options: { resume?: boolean; boundary?: JobPersistenceBoundary; exportOnly?: boolean },
  ) {
    this.directory = resolve(directory);
    this.databasePath = join(this.directory, "job.sqlite");
    this.boundary = options.boundary;
    this.exportingOnly = options.exportOnly === true;
    const metadataText = boundedJson(metadata, MAX_METADATA_BYTES, "Job metadata");
    const exists = existsSync(this.databasePath);
    if (options.resume === true && !exists) throw new Error(`Job does not exist: ${directory}`);
    if (options.resume !== true && exists) throw new Error(`Job already exists: ${directory}`);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.databasePath);
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA wal_autocheckpoint = 1000;
        PRAGMA max_page_count = 131072;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS items (
          ordinal INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          input TEXT NOT NULL,
          input_bytes INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          inflight INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          result TEXT,
          result_id TEXT UNIQUE,
          result_bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS pending_items ON items(state, ordinal);
        CREATE TABLE IF NOT EXISTS pages (
          ordinal INTEGER PRIMARY KEY,
          cursor TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          inflight INTEGER NOT NULL DEFAULT 0,
          error TEXT
        );
        CREATE TABLE IF NOT EXISTS repairs (
          ordinal INTEGER PRIMARY KEY,
          entry TEXT NOT NULL
        );
      `);
      this.transaction(undefined, () => {
        const previous = this.get<Owner>("owner");
        if (previous && ownerAlive(previous)) {
          throw new Error(
            `Job is locked by process ${previous.pid} on ${previous.host}; simultaneous resume is unsafe`,
          );
        }
        const recorded = this.get<JobMetadata>("metadata");
        if (recorded) {
          if (options.resume !== true) throw new Error(`Job already exists: ${directory}`);
          if (this.get<number>("format") !== FORMAT_VERSION)
            throw new Error("Incompatible durable job format");
          assertCompatible(recorded, metadata);
        } else {
          this.put("metadata", JSON.parse(metadataText));
          this.put("format", FORMAT_VERSION);
          this.put("createdAt", new Date().toISOString());
          this.put("state", { status: "running", termination: null, sourceExhausted: false });
        }
        this.put("owner", this.owner);
        if (this.exportingOnly) return;
        // Attempts are charged before browser work. A killed final attempt is never replayed.
        const maxAttempts = this.retry().maxAttempts;
        for (const table of ["items", "pages"]) {
          this.db
            .prepare(`UPDATE ${table} SET state = 'failed', inflight = 0,
            error = 'Process terminated during the final permitted attempt'
            WHERE state = 'pending' AND attempts >= ? AND inflight = 1`)
            .run(maxAttempts);
          this.db.exec(`UPDATE ${table} SET inflight = 0 WHERE state = 'pending'`);
        }
        const state = this.state();
        if (state.status === "interrupted" || state.termination === "error") {
          this.put("state", {
            status: "running",
            termination: null,
            sourceExhausted: state.sourceExhausted,
          });
        }
      });
      removeAbandonedSnapshots(this.directory);
      syncDirectory(this.directory);
      syncDirectory(dirname(this.directory));
    } catch (error) {
      // A failure after acquiring the lock must not leave this still-live PID owning it.
      try {
        if (this.get<Owner>("owner")?.token === this.owner.token)
          this.db.prepare("DELETE FROM meta WHERE key='owner'").run();
      } catch {
        /* Preserve the original opening error. */
      }
      this.db.close();
      throw error;
    }
  }

  configure(configuration: BatchConfiguration): void {
    validateConfiguration(configuration);
    const text = boundedJson(configuration, MAX_CONFIGURATION_BYTES, "Batch configuration");
    this.transaction("configure", () => {
      const previous = this.get<BatchConfiguration>("configuration");
      if (previous) {
        if (stableJson(previous) !== stableJson(configuration))
          throw new Error(
            "Batch configuration changed; resume requires the original acceptance and retry rules",
          );
        return;
      }
      this.put("configuration", JSON.parse(text));
      this.db.prepare("INSERT INTO pages(cursor) VALUES (?)").run(configuration.initialCursor);
    });
  }

  next(): NextWork {
    this.requireConfiguration();
    return this.transaction("attempt", () => {
      const state = this.state();
      if (state.status !== "running") return { kind: "done" };
      if (
        this.db
          .prepare(
            "SELECT 1 FROM items WHERE inflight = 1 UNION ALL SELECT 1 FROM pages WHERE inflight = 1 LIMIT 1",
          )
          .get()
      )
        throw new Error("Finish the current batch boundary before requesting more work");
      const counts = this.counts();
      const requested = this.requireConfiguration().acceptance.requestedCount;
      if (
        requested !== undefined &&
        counts.collected >= requested &&
        !this.requireConfiguration().acceptance.requireExhaustion
      ) {
        this.finishInTransaction("requested-count");
        return { kind: "done" };
      }
      const item = this.db
        .prepare("SELECT * FROM items WHERE state = 'pending' ORDER BY ordinal LIMIT 1")
        .get() as unknown as StoredItem | undefined;
      if (item) {
        const delayMs = Math.max(0, item.next_attempt_at - Date.now());
        if (delayMs) return { kind: "wait", delayMs };
        const attempt = item.attempts + 1;
        this.db
          .prepare("UPDATE items SET attempts = ?, inflight = 1, next_attempt_at = ? WHERE id = ?")
          .run(attempt, Date.now() + this.backoff(attempt), item.id);
        return { kind: "item", id: item.id, input: JSON.parse(item.input), attempt };
      }
      const failedPage = this.db
        .prepare("SELECT 1 FROM pages WHERE state = 'failed' LIMIT 1")
        .get();
      if (failedPage) {
        this.finishInTransaction("page-failed");
        return { kind: "done" };
      }
      const page = this.db
        .prepare("SELECT * FROM pages WHERE state = 'pending' ORDER BY ordinal LIMIT 1")
        .get() as unknown as StoredPage | undefined;
      if (page) {
        const delayMs = Math.max(0, page.next_attempt_at - Date.now());
        if (delayMs) return { kind: "wait", delayMs };
        const attempt = page.attempts + 1;
        this.db
          .prepare(
            "UPDATE pages SET attempts = ?, inflight = 1, next_attempt_at = ? WHERE cursor = ?",
          )
          .run(attempt, Date.now() + this.backoff(attempt), page.cursor);
        return { kind: "page", cursor: page.cursor, attempt };
      }
      this.finishInTransaction(state.sourceExhausted ? "source-exhausted" : "error");
      return { kind: "done" };
    });
  }

  page(work: PageWork, page: BatchPage): void {
    this.transaction("page", () => {
      this.assertWork(work);
      const limits = this.limits();
      if (!page || !Array.isArray(page.items) || typeof page.exhausted !== "boolean")
        throw new Error("A batch page requires items and an explicit exhausted flag");
      if (page.exhausted !== (page.nextCursor === null))
        throw new Error(
          "An exhausted page must have nextCursor null; a continuing page must have a cursor",
        );
      if (!page.exhausted) {
        assertId(page.nextCursor, "Next page cursor");
        if (this.db.prepare("SELECT 1 FROM pages WHERE cursor = ?").get(page.nextCursor!))
          throw new Error("Pagination repeated a cursor; collection termination is unproven");
      }
      if (page.items.length > limits.maxPageItems)
        throw new Error(`Page item limit of ${limits.maxPageItems} exceeded`);
      const counts = this.counts();
      if (!page.exhausted && counts.pages + 1 >= limits.maxPages)
        throw new Error(`Page limit of ${limits.maxPages} exceeded`);
      let total = counts.totalItems;
      let bytes = counts.bytes;
      const insert = this.db.prepare("INSERT INTO items(id,input,input_bytes) VALUES (?,?,?)");
      const existing = this.db.prepare("SELECT 1 FROM items WHERE id = ?");
      for (const item of page.items) {
        assertId(item.id, "Item ID");
        if (!item.input || typeof item.input !== "object" || Array.isArray(item.input))
          throw new Error("Batch item input must be an object");
        if (existing.get(item.id)) continue;
        const input = boundedJson(item.input, limits.maxInputBytes, "Item input");
        bytes += Buffer.byteLength(input);
        if (++total > limits.maxItems) throw new Error(`Item limit of ${limits.maxItems} exceeded`);
        if (bytes > limits.maxTotalBytes)
          throw new Error(`Job byte limit of ${limits.maxTotalBytes} exceeded`);
        insert.run(item.id, input, Buffer.byteLength(input));
      }
      this.db
        .prepare("UPDATE pages SET state='completed', inflight=0, error=NULL WHERE cursor=?")
        .run(work.cursor);
      if (page.nextCursor !== null)
        this.db.prepare("INSERT INTO pages(cursor) VALUES (?)").run(page.nextCursor);
      this.put("state", { ...this.state(), sourceExhausted: page.exhausted });
    });
  }

  commit(work: ItemWork, result: unknown, resultId: string): void {
    assertId(resultId, "Record ID");
    const limits = this.limits();
    const text = boundedJson(result, limits.maxResultBytes, "Item result");
    this.transaction("commit", () => {
      this.assertWork(work);
      if (this.counts().bytes + Buffer.byteLength(text) > limits.maxTotalBytes)
        throw new Error(`Job byte limit of ${limits.maxTotalBytes} exceeded`);
      if (
        this.db
          .prepare("SELECT 1 FROM items WHERE result_id = ? AND id != ?")
          .get(resultId, work.id)
      )
        throw new Error(`Duplicate record ID: ${resultId}`);
      // The result and completion marker share the same SQLite commit.
      this.db
        .prepare(
          "UPDATE items SET result=?, result_id=?, result_bytes=?, state='completed', inflight=0, error=NULL WHERE id=?",
        )
        .run(text, resultId, Buffer.byteLength(text), work.id);
    });
  }

  fail(work: BatchWork, error: string, eligible: boolean): void {
    this.transaction("failure", () => {
      this.assertWork(work);
      const retry = eligible && work.attempt < this.retry().maxAttempts;
      const table = work.kind === "item" ? "items" : "pages";
      const key = work.kind === "item" ? "id" : "cursor";
      const value = work.kind === "item" ? work.id : work.cursor;
      this.db
        .prepare(
          `UPDATE ${table} SET state=?, inflight=0, error=?, next_attempt_at=? WHERE ${key}=?`,
        )
        .run(
          retry ? "pending" : "failed",
          truncateError(error),
          Date.now() + this.backoff(work.attempt),
          value,
        );
    });
  }

  acceptRepair(entry: AcceptedJobRepair): void {
    const text = boundedJson(
      { ...entry, acceptedAt: entry.acceptedAt ?? new Date().toISOString() },
      MAX_METADATA_BYTES,
      "Repair record",
    );
    this.transaction("repair", () => {
      const metadata = this.get<JobMetadata>("metadata")!;
      if (metadata.dependencies[entry.actionId] !== entry.fromFingerprint)
        throw new Error(`Repair base fingerprint changed for ${entry.actionId}`);
      if (!entry.toFingerprint || entry.toVersion <= entry.fromVersion)
        throw new Error("Accepted repairs must advance an implementation version");
      const history = this.db
        .prepare(
          "SELECT count(*) AS count, coalesce(sum(length(CAST(entry AS BLOB))),0) AS bytes FROM repairs",
        )
        .get()!;
      if (
        Number(history.count) >= 1000 ||
        Number(history.bytes) + Buffer.byteLength(text) > MAX_REPAIR_HISTORY_BYTES
      )
        throw new Error("Job repair history limit exceeded (1000 entries or 8 MiB)");
      this.db.prepare("INSERT INTO repairs(entry) VALUES (?)").run(text);
      metadata.dependencies[entry.actionId] = entry.toFingerprint;
      this.put("metadata", metadata);
    });
  }

  finish(reason?: JobTermination, detail?: string): JobSummary {
    this.transaction("finish", () => {
      const state = this.state();
      if (state.status !== "running" && reason === undefined) return;
      this.finishInTransaction(reason ?? (state.sourceExhausted ? "source-exhausted" : "error"));
      if (detail !== undefined)
        this.put("state", { ...this.state(), reason: truncateError(detail) });
    });
    return this.summary();
  }

  interrupt(reason: string): JobSummary {
    this.transaction("finish", () => {
      this.put("state", {
        ...this.state(),
        status: "interrupted",
        termination: "interrupted",
        reason: truncateError(reason),
      });
    });
    return this.summary();
  }

  summary(): JobSummary {
    this.assertOpen();
    const summary = readSummary(this.db, this.directory);
    if (this.exportingOnly && summary.status === "running") {
      summary.status = "interrupted";
      summary.termination = "interrupted";
      summary.reason =
        "The process stopped before recording a final outcome; committed results remain available";
    }
    return summary;
  }

  /** Stream committed records into replaceable snapshots; never treat a partial file as authoritative. */
  export(): JobSummary {
    this.assertOwner();
    writeSnapshot(
      this.directory,
      "results.ndjson",
      this.db
        .prepare("SELECT result AS line FROM items WHERE state='completed' ORDER BY ordinal")
        .iterate(),
    );
    const failures = this.db
      .prepare(`
      SELECT json_object('kind','item','id',id,'attempts',attempts,'error',error) AS line FROM items WHERE state='failed'
      UNION ALL SELECT json_object('kind','page','cursor',cursor,'attempts',attempts,'error',error) AS line FROM pages WHERE state='failed'
    `)
      .iterate();
    writeSnapshot(this.directory, "failures.ndjson", failures);
    const summary = this.summary();
    writeSnapshot(this.directory, "summary.json", [{ line: JSON.stringify(summary, null, 2) }]);
    return summary;
  }

  close(): void {
    if (this.closed) return;
    try {
      this.transaction(undefined, () => {
        if (this.get<Owner>("owner")?.token === this.owner.token)
          this.db.prepare("DELETE FROM meta WHERE key='owner'").run();
      });
    } finally {
      this.closed = true;
      this.db.close();
    }
  }

  private state(): State {
    return this.get<State>("state")!;
  }

  private requireConfiguration(): BatchConfiguration {
    const configuration = this.get<BatchConfiguration>("configuration");
    if (!configuration) throw new Error("Configure the batch before requesting work");
    return configuration;
  }

  private limits(): typeof DEFAULT_LIMITS {
    return { ...DEFAULT_LIMITS, ...this.get<BatchConfiguration>("configuration")?.limits };
  }

  private retry(): typeof DEFAULT_RETRY {
    return { ...DEFAULT_RETRY, ...this.get<BatchConfiguration>("configuration")?.retry };
  }

  private backoff(attempt: number): number {
    const retry = this.retry();
    return Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** Math.min(attempt - 1, 30));
  }

  private counts() {
    return readCounts(this.db);
  }

  private assertWork(work: BatchWork): void {
    this.assertOwner();
    const table = work.kind === "item" ? "items" : "pages";
    const key = work.kind === "item" ? "id" : "cursor";
    const value = work.kind === "item" ? work.id : work.cursor;
    const row = this.db
      .prepare(`SELECT state,attempts,inflight FROM ${table} WHERE ${key}=?`)
      .get(value) as unknown as StoredWork | undefined;
    if (!row || row.state !== "pending" || row.inflight !== 1 || row.attempts !== work.attempt)
      throw new Error("Stale or unallocated batch work cannot be committed");
  }

  private finishInTransaction(reason: JobTermination): void {
    const counts = this.counts();
    const current = this.state();
    const configuration = this.get<BatchConfiguration>("configuration");
    if (!configuration) {
      this.put("state", {
        ...current,
        status: reason === "interrupted" ? "interrupted" : "failed",
        termination: reason === "interrupted" || reason === "limit" ? reason : "error",
        reason: "Execution ended before configuring its durable batch",
      });
      return;
    }
    const acceptance = configuration.acceptance;
    const reachedCount =
      acceptance.requestedCount !== undefined && counts.collected >= acceptance.requestedCount;
    const countSatisfied = acceptance.requestedCount === undefined || reachedCount;
    const nonempty = counts.collected > 0 || acceptance.allowEmpty === true;
    const terminated =
      reason === "requested-count"
        ? reachedCount
        : reason === "source-exhausted" && current.sourceExhausted && counts.pending === 0;
    const complete =
      counts.failed === 0 &&
      counts.failedPages === 0 &&
      countSatisfied &&
      nonempty &&
      terminated &&
      (!acceptance.requireExhaustion || current.sourceExhausted);
    this.put("state", {
      ...current,
      status:
        reason === "interrupted"
          ? "interrupted"
          : complete
            ? "complete"
            : counts.collected === 0 &&
                (reason === "error" || reason === "page-failed" || reason === "limit")
              ? "failed"
              : "incomplete",
      termination: reason,
    });
  }

  private get<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return row ? (JSON.parse(row.value as string) as T) : undefined;
  }

  private put(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Job is closed");
  }

  private assertOwner(): void {
    this.assertOpen();
    if (this.get<Owner>("owner")?.token !== this.owner.token)
      throw new Error("Job process lock was lost");
  }

  private transaction<T>(
    operation: Parameters<JobPersistenceBoundary>[0] | undefined,
    work: () => T,
  ): T {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      if (operation !== undefined) this.assertOwner();
      const result = work();
      if (operation !== undefined) this.boundary?.(operation, "before-commit");
      this.db.exec("COMMIT");
      committed = true;
      if (operation !== undefined) this.boundary?.(operation, "after-commit");
      return result;
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function inspectJob(directory: string): JobInspection {
  const root = resolve(directory);
  const db = new DatabaseSync(join(root, "job.sqlite"), { readOnly: true });
  let transaction = false;
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN");
    transaction = true;
    const read = <T>(key: string): T | undefined => {
      const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
      return row ? (JSON.parse(row.value as string) as T) : undefined;
    };
    if (read<number>("format") !== FORMAT_VERSION)
      throw new Error("Incompatible durable job format");
    const configuration = read<BatchConfiguration>("configuration");
    const summary = readSummary(db, root);
    const owner = read<Owner>("owner");
    if (summary.status === "running" && (!owner || !ownerAlive(owner))) {
      summary.status = "interrupted";
      summary.termination = "interrupted";
      summary.reason =
        "The process stopped before recording a final outcome; committed results remain available";
    }
    return {
      metadata: read<JobMetadata>("metadata")!,
      ...(configuration ? { configuration } : {}),
      summary,
      acceptedRepairs: db
        .prepare("SELECT entry FROM repairs ORDER BY ordinal")
        .all()
        .map((row) => JSON.parse(row.entry as string) as AcceptedJobRepair),
    };
  } finally {
    if (transaction) db.exec("ROLLBACK");
    db.close();
  }
}

function readCounts(db: DatabaseSync) {
  const items = db
    .prepare(`SELECT count(*) AS totalItems,
    coalesce(sum(state='completed'),0) AS collected, coalesce(sum(state='pending'),0) AS pending,
    coalesce(sum(state='failed'),0) AS failed, coalesce(sum(attempts),0) AS attempts,
    coalesce(sum(input_bytes+result_bytes),0) AS bytes FROM items`)
    .get()!;
  const pages = db
    .prepare(`SELECT coalesce(sum(state='completed'),0) AS pages,
    coalesce(sum(state='failed'),0) AS failedPages, coalesce(sum(attempts),0) AS attempts FROM pages`)
    .get()!;
  return {
    totalItems: Number(items.totalItems),
    collected: Number(items.collected),
    pending: Number(items.pending),
    failed: Number(items.failed),
    pages: Number(pages.pages),
    failedPages: Number(pages.failedPages),
    attempts: Number(items.attempts) + Number(pages.attempts),
    bytes: Number(items.bytes),
  };
}

function readSummary(db: DatabaseSync, directory: string): JobSummary {
  const state = JSON.parse(
    db.prepare("SELECT value FROM meta WHERE key='state'").get()!.value as string,
  ) as State;
  const configRow = db.prepare("SELECT value FROM meta WHERE key='configuration'").get();
  const config = configRow
    ? (JSON.parse(configRow.value as string) as BatchConfiguration)
    : undefined;
  const { totalItems: _total, bytes: _bytes, ...counts } = readCounts(db);
  return {
    id: basename(directory),
    directory,
    ...state,
    ...counts,
    ...(config?.acceptance.requestedCount === undefined
      ? {}
      : { requestedCount: config.acceptance.requestedCount }),
    outputPath: join(directory, "results.ndjson"),
    failuresPath: join(directory, "failures.ndjson"),
    databasePath: join(directory, "job.sqlite"),
    repairs: Number(db.prepare("SELECT count(*) AS count FROM repairs").get()!.count),
  };
}

function ownerAlive(owner: Owner): boolean {
  // Cross-host PID checks are meaningless. Shared/network filesystems require manual intervention.
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function assertCompatible(recorded: JobMetadata, current: JobMetadata): void {
  const immutable = (metadata: JobMetadata) => ({
    ...metadata,
    automation: {
      ...metadata.automation,
      // Implementation versions can advance through a recorded accepted repair. Hashes below
      // still reject every unrecorded source/contract edit, including same-version edits.
      ...(metadata.automation.dependencies
        ? {
            dependencies: metadata.automation.dependencies.map(
              ({ actionVersion: _version, ...rest }) => rest,
            ),
          }
        : {}),
    },
  });
  if (stableJson(immutable(recorded)) !== stableJson(immutable(current)))
    throw new Error(
      "Job is incompatible with the current automation, inputs, runtime, or action fingerprints; start a new job",
    );
}

function validateConfiguration(config: BatchConfiguration): void {
  assertId(config.key, "Batch key");
  assertId(config.initialCursor, "Initial page cursor");
  const checks = config.acceptance;
  if (
    !checks ||
    !Array.isArray(checks.requiredFields) ||
    checks.requiredFields.some((field) => typeof field !== "string" || !field.trim()) ||
    !checks.idField ||
    !checks.sourceUrlField
  )
    throw new Error("Batch acceptance requires requiredFields, idField, and sourceUrlField");
  if (
    checks.requestedCount !== undefined &&
    (!Number.isSafeInteger(checks.requestedCount) || checks.requestedCount < 1)
  )
    throw new Error("requestedCount must be a positive integer");
  const retry = { ...DEFAULT_RETRY, ...config.retry };
  if (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > 10)
    throw new Error("Retry maxAttempts must be between 1 and 10");
  if (
    ![retry.baseDelayMs, retry.maxDelayMs].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 60_000,
    ) ||
    retry.maxDelayMs < retry.baseDelayMs
  )
    throw new Error("Retry delays must be bounded between 0 and 60000 milliseconds");
  for (const [key, value] of Object.entries(config.limits ?? {})) {
    const ceiling = DEFAULT_LIMITS[key as keyof typeof DEFAULT_LIMITS];
    if (ceiling === undefined || !Number.isSafeInteger(value) || value < 1 || value > ceiling)
      throw new Error(`Batch limit ${key} must be positive and no greater than ${ceiling}`);
  }
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4096)
    throw new Error(`${label} must be a nonempty string of at most 4096 bytes`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

function boundedJson(value: unknown, maxBytes: number, label: string): string {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (
      item === undefined ||
      typeof item === "function" ||
      typeof item === "symbol" ||
      typeof item === "bigint" ||
      (typeof item === "number" && !Number.isFinite(item))
    )
      throw new Error(`${label} must be lossless JSON`);
    return item;
  });
  if (text === undefined || Buffer.byteLength(text) > maxBytes)
    throw new Error(`${label} exceeds the ${maxBytes} byte limit`);
  return text;
}

function truncateError(error: string): string {
  return Buffer.from(String(error)).subarray(0, MAX_ERROR_BYTES).toString("utf8");
}

function writeSnapshot(
  directory: string,
  name: string,
  rows: Iterable<Record<string, unknown>>,
): void {
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    for (const row of rows) {
      const data = Buffer.from(`${String(row.line)}\n`);
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset);
    }
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, join(directory, name));
  syncDirectory(directory);
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeAbandonedSnapshots(directory: string): void {
  const entries = opendirSync(directory);
  try {
    for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
      if (
        entry.isFile() &&
        /^\.(results\.ndjson|failures\.ndjson|summary\.json)-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.tmp$/.test(
          entry.name,
        )
      )
        unlinkSync(join(directory, entry.name));
    }
  } finally {
    entries.closeSync();
  }
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { DurableJob, inspectJob } from "../store.js";
import type { BatchConfiguration, ItemWork, JobMetadata, PageWork } from "../types.js";

const metadata: JobMetadata = {
  automation: {
    id: "catalog",
    siteId: "fixture.local",
    source: "export default defineAutomation(async () => []);",
    version: 1,
  },
  input: { category: "books" },
  startUrl: "https://fixture.local/catalog",
  runtimeFingerprint: "runtime-v1",
  dependencies: { extract: "action-v1" },
};

const configuration: BatchConfiguration = {
  key: "records",
  initialCursor: "page-1",
  acceptance: { requiredFields: ["title"], idField: "id", sourceUrlField: "url" },
  retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
};

async function withDirectory(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mosaik-job-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function item(id: string) {
  return { id, input: { url: `https://fixture.local/items/${id}` } };
}

function record(id: string) {
  return { id, title: `Record ${id}`, url: `https://fixture.local/items/${id}` };
}

test("page transactions deduplicate stable IDs and expose bounded committed snapshots", async () => {
  await withDirectory(async (root) => {
    const job = DurableJob.open(root, metadata);
    try {
      job.configure(configuration);
      const page = job.next() as PageWork;
      job.page(page, {
        items: [item("a"), item("a"), item("b")],
        nextCursor: "page-2",
        exhausted: false,
      });
      const first = job.next() as ItemWork;
      job.commit(first, record(first.id), first.id);
      const second = job.next() as ItemWork;
      job.commit(second, record(second.id), second.id);
      job.page(job.next() as PageWork, {
        items: [item("a"), item("c")],
        nextCursor: null,
        exhausted: true,
      });
      const third = job.next() as ItemWork;
      job.commit(third, record(third.id), third.id);
      assert.equal(job.next().kind, "done");
      assert.equal(job.summary().status, "complete");
      assert.equal(job.summary().collected, 3);
      assert.equal(job.summary().pages, 2);
      job.export();
      const records = (await readFile(join(root, "results.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(records, [record("a"), record("b"), record("c")]);
      assert.equal(await readFile(join(root, "failures.ndjson"), "utf8"), "");
    } finally {
      job.close();
    }
  });
});

test("requested count, source exhaustion, empty collections and missing counts stay distinct", async () => {
  await withDirectory(async (root) => {
    for (const [name, acceptance, items, expectedStatus, termination] of [
      [
        "count",
        { ...configuration.acceptance, requestedCount: 1 },
        [item("a"), item("b")],
        "complete",
        "requested-count",
      ],
      [
        "missing",
        { ...configuration.acceptance, requestedCount: 3 },
        [item("a"), item("b")],
        "incomplete",
        "source-exhausted",
      ],
      ["empty", configuration.acceptance, [], "incomplete", "source-exhausted"],
      [
        "explicit-empty",
        { ...configuration.acceptance, allowEmpty: true },
        [],
        "complete",
        "source-exhausted",
      ],
    ] as const) {
      const job = DurableJob.open(join(root, name), metadata);
      try {
        job.configure({ ...configuration, acceptance });
        job.page(job.next() as PageWork, { items: [...items], nextCursor: null, exhausted: true });
        for (;;) {
          const work = job.next();
          if (work.kind === "done") break;
          assert.equal(work.kind, "item");
          const current = work as ItemWork;
          job.commit(current, record(current.id), current.id);
        }
        assert.equal(job.summary().status, expectedStatus);
        assert.equal(job.summary().termination, termination);
      } finally {
        job.close();
      }
    }
  });
});

test("retry attempts survive reopening, bound retryable work, and never retry permanent errors", async () => {
  await withDirectory(async (root) => {
    let job = DurableJob.open(root, metadata);
    job.configure({ ...configuration, retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } });
    job.page(job.next() as PageWork, {
      items: [item("a"), item("b")],
      nextCursor: null,
      exhausted: true,
    });
    const first = job.next() as ItemWork;
    assert.equal(first.attempt, 1);
    job.fail(first, "temporarily unavailable", true);
    job.close();
    job = DurableJob.open(root, metadata, { resume: true });
    try {
      const retry = job.next() as ItemWork;
      assert.equal(retry.id, "a");
      assert.equal(retry.attempt, 2);
      job.fail(retry, "still unavailable", true);
      const permanent = job.next() as ItemWork;
      job.fail(permanent, "malformed record", false);
      assert.equal(job.next().kind, "done");
      assert.equal(job.summary().failed, 2);
      assert.equal(job.summary().status, "incomplete");
      job.export();
      const failures = (await readFile(join(root, "failures.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        failures.map((failure) => [failure.id, failure.attempts]),
        [
          ["a", 2],
          ["b", 1],
        ],
      );
    } finally {
      job.close();
    }
  });
});

test("backoff is persisted before work begins and a retry must wait", async () => {
  await withDirectory(async (root) => {
    const job = DurableJob.open(root, metadata);
    try {
      job.configure({
        ...configuration,
        retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 500 },
      });
      const work = job.next() as PageWork;
      job.fail(work, "temporary upstream error", true);
      const pending = job.next();
      assert.equal(pending.kind, "wait");
      if (pending.kind === "wait") assert(pending.delayMs > 0 && pending.delayMs <= 500);
    } finally {
      job.close();
    }
  });
});

test("pagination cycles, duplicate record IDs and quota violations fail before partial transactions commit", async () => {
  await withDirectory(async (root) => {
    const job = DurableJob.open(root, metadata);
    try {
      job.configure({ ...configuration, limits: { maxItems: 2 } });
      const page = job.next() as PageWork;
      assert.throws(
        () => job.page(page, { items: [item("a")], nextCursor: "page-1", exhausted: false }),
        /repeated a cursor/,
      );
      assert.throws(
        () =>
          job.page(page, {
            items: [item("a"), item("b"), item("c")],
            nextCursor: null,
            exhausted: true,
          }),
        /Item limit/,
      );
      assert.equal(job.summary().pending, 0);
      assert.equal(job.summary().pages, 0);
      job.page(page, { items: [item("a"), item("b")], nextCursor: null, exhausted: true });
      const first = job.next() as ItemWork;
      job.commit(first, record("shared"), "shared");
      const second = job.next() as ItemWork;
      assert.throws(() => job.commit(second, record("shared"), "shared"), /Duplicate record ID/);
      assert.equal(job.summary().collected, 1);
      job.fail(second, "duplicate record ID", false);
      assert.equal(job.next().kind, "done");
      assert.equal(job.summary().status, "incomplete");
    } finally {
      job.close();
    }
  });
});

test("resume rejects unrelated edits but recognizes explicitly accepted repairs", async () => {
  await withDirectory(async (root) => {
    const job = DurableJob.open(root, metadata);
    job.configure(configuration);
    job.acceptRepair({
      actionId: "extract",
      fromFingerprint: "action-v1",
      toFingerprint: "action-v2",
      fromVersion: 1,
      toVersion: 2,
      evidence: "historical cases passed",
    });
    job.close();
    assert.equal(inspectJob(root).acceptedRepairs.length, 1);
    assert.throws(() => DurableJob.open(root, metadata, { resume: true }), /incompatible/);
    const repaired = { ...metadata, dependencies: { extract: "action-v2" } };
    const resumed = DurableJob.open(root, repaired, { resume: true });
    resumed.close();
    for (const changed of [
      { ...repaired, input: { category: "games" } },
      { ...repaired, runtimeFingerprint: "runtime-v2" },
      { ...repaired, automation: { ...metadata.automation, source: "unrelated source edit" } },
      { ...repaired, dependencies: { extract: "unrecorded-source-edit" } },
    ])
      assert.throws(() => DurableJob.open(root, changed, { resume: true }), /incompatible/);
  });
});

test("live owners exclude simultaneous resume in the same and another process", async () => {
  await withDirectory(async (root) => {
    const job = DurableJob.open(root, metadata);
    try {
      job.configure(configuration);
      assert.throws(() => DurableJob.open(root, metadata, { resume: true }), /locked by process/);
      const script = join(root, "competing.mjs");
      await writeFile(
        script,
        `import { DurableJob } from ${JSON.stringify(storeUrl())};\ntry { DurableJob.open(${JSON.stringify(root)}, ${JSON.stringify(metadata)}, {resume:true}); process.exit(2); } catch (error) { if (!error.message.includes('locked by process')) throw error; }\n`,
      );
      const result = await child(script);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(job.summary().status, "running");
    } finally {
      job.close();
    }
  });
});

test("a stopped job cleans only its abandoned export snapshots after acquiring its lock", async () => {
  await withDirectory(async (root) => {
    const job = DurableJob.open(root, metadata);
    job.configure(configuration);
    job.close();
    const abandoned = ".results.ndjson-12345678-abcd-1234-abcd-123456789012.tmp";
    await writeFile(join(root, abandoned), "partial snapshot");
    await writeFile(join(root, "unrelated.tmp"), "preserve me");
    const resumed = DurableJob.open(root, metadata, { resume: true });
    try {
      assert(!(await readdir(root)).includes(abandoned));
      assert.equal(await readFile(join(root, "unrelated.tmp"), "utf8"), "preserve me");
    } finally {
      resumed.close();
    }
  });
});

test("early failures and interruption are reportable before a batch is configured", async () => {
  await withDirectory(async (root) => {
    const job = DurableJob.open(root, metadata);
    job.finish("error", "Browser launch failed");
    assert.equal(job.export().status, "failed");
    assert.equal(job.summary().reason, "Browser launch failed");
    job.close();
    const resumed = DurableJob.open(root, metadata, { resume: true });
    try {
      resumed.finish("interrupted", "Cancelled before navigation");
      assert.equal(resumed.export().status, "interrupted");
      assert.equal(resumed.summary().termination, "interrupted");
      assert.equal(await readFile(join(root, "results.ndjson"), "utf8"), "");
    } finally {
      resumed.close();
    }
  });
});

for (const operation of ["commit", "page"] as const) {
  for (const phase of ["before-commit", "after-commit"] as const) {
    test(`SIGKILL ${operation} ${phase} leaves a resumable transaction with exactly-once output`, async () => {
      await withDirectory(async (root) => {
        const directory = join(root, "job");
        const script = join(root, "crash.mjs");
        await writeFile(
          script,
          `
          import { DurableJob } from ${JSON.stringify(storeUrl())};
          const job = DurableJob.open(${JSON.stringify(directory)}, ${JSON.stringify(metadata)}, {
            boundary(operation, phase) { if(operation === ${JSON.stringify(operation)} && phase === ${JSON.stringify(phase)}) process.kill(process.pid, 'SIGKILL'); }
          });
          job.configure(${JSON.stringify(configuration)});
          job.page(job.next(), {items: ${JSON.stringify([item("a"), item("b")])}, nextCursor:null, exhausted:true});
          const work = job.next();
          job.commit(work, ${JSON.stringify(record("a"))}, 'a');
          throw new Error('The persistence boundary did not kill this child');
        `,
        );
        const result = await child(script);
        assert.equal(result.signal, "SIGKILL", result.stderr);
        const before = inspectJob(directory);
        assert.equal(before.summary.status, "interrupted");
        assert.equal(
          before.summary.collected,
          operation === "commit" && phase === "after-commit" ? 1 : 0,
        );
        const job = DurableJob.open(directory, metadata, { resume: true });
        try {
          job.configure(configuration);
          for (;;) {
            const work = job.next();
            if (work.kind === "done") break;
            if (work.kind === "page")
              job.page(work, { items: [item("a"), item("b")], nextCursor: null, exhausted: true });
            else if (work.kind === "item") job.commit(work, record(work.id), work.id);
            else throw new Error("Zero-backoff fixture unexpectedly waited");
          }
          assert.equal(job.summary().status, "complete");
          assert.equal(job.summary().collected, 2);
          job.export();
          const records = (await readFile(join(directory, "results.ndjson"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.deepEqual(records, [record("a"), record("b")]);
        } finally {
          job.close();
        }
      });
    });
  }
}

test("SIGKILL during the final allowed attempt is recorded as failed instead of replaying forever", async () => {
  await withDirectory(async (root) => {
    const directory = join(root, "job");
    const script = join(root, "final-attempt.mjs");
    await writeFile(
      script,
      `
      import { DurableJob } from ${JSON.stringify(storeUrl())};
      const job = DurableJob.open(${JSON.stringify(directory)}, ${JSON.stringify(metadata)}, {
        boundary(operation, phase) { if (operation === 'attempt' && phase === 'after-commit') process.kill(process.pid, 'SIGKILL'); }
      });
      job.configure(${JSON.stringify({ ...configuration, retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } })});
      job.next();
    `,
    );
    const stopped = await child(script);
    assert.equal(stopped.signal, "SIGKILL", stopped.stderr);
    const exported = DurableJob.exportExisting(directory);
    assert.equal(exported.status, "interrupted");
    assert.equal(exported.failedPages, 0);
    assert.equal(inspectJob(directory).summary.failedPages, 0);
    const job = DurableJob.open(directory, metadata, { resume: true });
    try {
      assert.equal(job.next().kind, "done");
      assert.equal(job.summary().failedPages, 1);
      assert.equal(job.summary().attempts, 1);
      assert.equal(job.summary().status, "failed");
      assert.equal(job.summary().termination, "page-failed");
    } finally {
      job.close();
    }
  });
});

function storeUrl(): string {
  return new URL("../store.ts", import.meta.url).href;
}

function child(
  script: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const process = spawn(globalThis.process.execPath, ["--import", tsx, script], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    process.stderr.on("data", (data) => {
      stderr += String(data);
    });
    process.once("error", reject);
    process.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

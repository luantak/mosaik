import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import type { ComposedAutomation } from "../../automations/types.js";
import { defineAction, string } from "../../capabilities/index.js";
import { createMemoryRegistry, type SiteActionRegistry } from "../../capabilities/lookup.js";
import type { SiteActionDefinition } from "../../capabilities/types.js";
import { extractText, testId } from "../../core/index.js";
import { actionFingerprint } from "../fingerprint.js";
import { prepareDurableJob, prepareJobMetadata, prepareResumeMetadata } from "../prepare.js";
import { DurableJob, inspectJob } from "../store.js";
import type { AcceptedJobRepair, BatchConfiguration, ItemWork, PageWork } from "../types.js";

const automation: ComposedAutomation = {
  id: "catalog",
  siteId: "fixture.local",
  version: 1,
  durable: true,
  source: "export default defineAutomation(async (ctx) => { return ctx.input; });",
};
const base = action(1, "old-title");
const second = action(2, "current-title");
const third = action(3, "title-again");
const configuration: BatchConfiguration = {
  key: "records",
  initialCursor: "https://fixture.local/catalog",
  acceptance: { requiredFields: ["title"], idField: "id", sourceUrlField: "url" },
  retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
};

function action(version: number, locator: string): SiteActionDefinition {
  return defineAction({
    id: "fixture.readTitle",
    siteId: "fixture.local",
    name: "readTitle",
    description: "Read the title from the current record page",
    safety: "read-only",
    outputs: { title: string() },
    version,
    steps: [
      extractText({ id: "title", locator: testId(locator), output: "title", safety: "read-only" }),
    ],
  });
}

function repair(from: SiteActionDefinition, to: SiteActionDefinition): AcceptedJobRepair {
  return {
    actionId: from.id,
    fromFingerprint: actionFingerprint(from),
    toFingerprint: actionFingerprint(to),
    fromVersion: from.version,
    toVersion: to.version,
    action: to,
    evidence: "Fixture journal: validated locator proposal",
  };
}

async function withDirectory(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mosaik-repair-recovery-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seed(
  directory: string,
  entries: AcceptedJobRepair[] = [repair(base, second)],
): Promise<void> {
  const metadata = await prepareJobMetadata(automation, [base], {});
  const job = DurableJob.open(directory, metadata);
  try {
    job.configure(configuration);
    job.page(job.next() as PageWork, {
      items: [
        { id: "done", input: {} },
        { id: "pending", input: {} },
      ],
      nextCursor: null,
      exhausted: true,
    });
    job.commit(
      job.next() as ItemWork,
      { id: "done", title: "Already committed", url: "https://fixture.local/done" },
      "done",
    );
    for (const entry of entries) job.acceptRepair(entry);
  } finally {
    job.close();
  }
}

function options(directory: string, registry: SiteActionRegistry) {
  return { registry, job: { directory, resume: true } };
}

test("resume restores only the journaled accepted repair and preserves committed records", async () => {
  await withDirectory(async (root) => {
    await seed(root);
    const registry = createMemoryRegistry([base]);
    const actions = [base];
    const job = await prepareDurableJob(automation, actions, options(root, registry));
    assert(job);
    try {
      assert.equal(actionFingerprint((await registry.get(base.id))!), actionFingerprint(second));
      assert.equal(actionFingerprint(actions[0]!), actionFingerprint(second));
      assert.equal(job.summary().collected, 1);
      assert.equal(job.summary().repairs, 1);
      job.export();
      const lines = (await readFile(join(root, "results.ndjson"), "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]!).id, "done");
      assert.equal((job.next() as ItemWork).id, "pending");
    } finally {
      job.close();
    }
  });
});

test("resume recovers a contiguous chain from an intermediate accepted implementation", async () => {
  await withDirectory(async (root) => {
    await seed(root, [repair(base, second), repair(second, third)]);
    const registry = createMemoryRegistry([second]);
    let writes = 0;
    const realUpdate = registry.updateActionIfVersion.bind(registry);
    registry.updateActionIfVersion = async (input) => {
      writes++;
      return realUpdate(input);
    };
    const actions = [second];
    const job = await prepareDurableJob(automation, actions, options(root, registry));
    assert(job);
    job.close();
    assert.equal(writes, 1);
    assert.equal(actionFingerprint(actions[0]!), actionFingerprint(third));
    const alreadyRecovered = await prepareDurableJob(automation, actions, options(root, registry));
    alreadyRecovered!.close();
    assert.equal(writes, 1, "An already installed repair should not be written again");
    assert.equal(inspectJob(root).summary.collected, 1);
  });
});

test("read-only resume preflight recognizes accepted repair predecessors without registry writes", async () => {
  await withDirectory(async (root) => {
    await seed(root);
    const current = await prepareResumeMetadata(root, automation, [base], {});
    assert.equal(current.dependencies[base.id], actionFingerprint(second));
    assert.equal(actionFingerprint(base), repair(base, second).fromFingerprint);
    await assert.rejects(
      prepareResumeMetadata(root, automation, [action(1, "unrelated-edit")], {}),
      /Unrecorded action edit/,
    );
  });
});

test("unrelated same-version edits and malformed accepted snapshots cannot be overwritten", async () => {
  await withDirectory(async (root) => {
    const unrelated = action(1, "unrelated-edit");
    const directory = join(root, "edited");
    await seed(directory);
    const registry = createMemoryRegistry([unrelated]);
    await assert.rejects(
      prepareDurableJob(automation, [unrelated], options(directory, registry)),
      /Unrecorded action edit/,
    );
    assert.equal(actionFingerprint((await registry.get(base.id))!), actionFingerprint(unrelated));
    assert.equal(inspectJob(directory).summary.collected, 1);

    const malformed = join(root, "malformed");
    await seed(malformed, [{ ...repair(base, second), action: third }]);
    const original = createMemoryRegistry([base]);
    await assert.rejects(
      prepareDurableJob(automation, [base], options(malformed, original)),
      /snapshot is missing or incompatible/,
    );
    assert.equal(actionFingerprint((await original.get(base.id))!), actionFingerprint(base));
  });
});

test("a live job owner prevents repair recovery from mutating the shared library", async () => {
  await withDirectory(async (root) => {
    await seed(root);
    const inspection = inspectJob(root);
    const owner = DurableJob.open(root, inspection.metadata, { resume: true });
    try {
      const registry = createMemoryRegistry([base]);
      await assert.rejects(
        prepareDurableJob(automation, [base], options(root, registry)),
        /locked by process/,
      );
      assert.equal(actionFingerprint((await registry.get(base.id))!), actionFingerprint(base));
    } finally {
      owner.close();
    }
  });
});

test("a recovery CAS conflict releases the job lock and preserves completed work", async () => {
  await withDirectory(async (root) => {
    await seed(root);
    const registry = createMemoryRegistry([base]);
    const update = registry.updateActionIfVersion.bind(registry);
    registry.updateActionIfVersion = async () => ({
      updated: false,
      reason: "version-conflict",
      current: base,
    });
    await assert.rejects(
      prepareDurableJob(automation, [base], options(root, registry)),
      /recovery conflicted/,
    );
    registry.updateActionIfVersion = update;
    const recovered = await prepareDurableJob(automation, [base], options(root, registry));
    assert.equal(recovered!.summary().collected, 1);
    recovered!.close();
  });
});

test("a second interruption during recovery resumes from the last installed journaled snapshot", async () => {
  await withDirectory(async (root) => {
    await seed(root, [repair(base, second), repair(second, third)]);
    const registry = createMemoryRegistry([base]);
    const update = registry.updateActionIfVersion.bind(registry);
    let writes = 0;
    registry.updateActionIfVersion = async (input) => {
      if (++writes === 2) throw new Error("Simulated interrupted library write");
      return update(input);
    };
    await assert.rejects(
      prepareDurableJob(automation, [base], options(root, registry)),
      /interrupted library write/,
    );
    assert.equal(actionFingerprint((await registry.get(base.id))!), actionFingerprint(second));
    registry.updateActionIfVersion = update;
    const actions = [(await registry.get(base.id))!];
    const recovered = await prepareDurableJob(automation, actions, options(root, registry));
    assert.equal(actionFingerprint(actions[0]!), actionFingerprint(third));
    assert.equal(recovered!.summary().collected, 1);
    recovered!.close();
  });
});

for (const phase of ["before-commit", "after-commit"] as const) {
  test(`SIGKILL ${phase} of repair journal commit recovers without redoing committed items`, async () => {
    await withDirectory(async (root) => {
      const directory = join(root, "job");
      await seed(directory, []);
      const metadata = inspectJob(directory).metadata;
      const script = join(root, "repair-crash.mjs");
      await writeFile(
        script,
        `
        import { DurableJob } from ${JSON.stringify(new URL("../store.ts", import.meta.url).href)};
        const job = DurableJob.open(${JSON.stringify(directory)}, ${JSON.stringify(metadata)}, {
          resume: true,
          boundary(operation, phase) { if (operation === 'repair' && phase === ${JSON.stringify(phase)}) process.kill(process.pid, 'SIGKILL'); }
        });
        job.acceptRepair(${JSON.stringify(repair(base, second))});
        throw new Error('Repair boundary did not terminate process');
      `,
      );
      const stopped = await killChild(script);
      assert.equal(stopped.signal, "SIGKILL", stopped.stderr);
      const registry = createMemoryRegistry([base]);
      const actions = [base];
      const job = await prepareDurableJob(automation, actions, options(directory, registry));
      assert(job);
      try {
        assert.equal(
          actionFingerprint(actions[0]!),
          actionFingerprint(phase === "after-commit" ? second : base),
        );
        assert.equal(job.summary().collected, 1);
        assert.equal(job.summary().repairs, phase === "after-commit" ? 1 : 0);
        assert.equal((job.next() as ItemWork).id, "pending");
      } finally {
        job.close();
      }
    });
  });
}

function killChild(script: string): Promise<{ signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const child = spawn(process.execPath, ["--import", tsx, script], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.once("error", reject);
    child.once("close", (_code, signal) => resolve({ signal, stderr }));
  });
}

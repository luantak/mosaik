# Learn, execute, interrupt, resume, verify

Mosaik distinguishes **execution success** from **task completion**. A browser
program can return successfully while records are missing. Saved execution never
composes again and never calls a provider. The composition cache still includes
inputs; selecting an existing automation is a separate operation.

## Install an artifact or use the checkout

Node 22.18+ is required (Node 24 is used in the focused evaluation). A release
artifact includes the CLI, fixture/demo commands, runtime plugins and public
TypeScript declarations. Publishing is a separate step; this change does not
publish a release. For a locally prepared tarball:

```sh
export MOSAIK_PACKAGE=/absolute/path/to/mosaik-0.1.0.tgz
npm install --global "$MOSAIK_PACKAGE"
mosaik init ./catalogue --no-install
cd catalogue
pnpm add "$MOSAIK_PACKAGE"
mosaik setup
```

`init` normally installs the exact version of its installed Mosaik package from
the registry. `--no-install` followed by `pnpm add <tarball>` supports an
unpublished artifact. No source checkout link is needed. Contributors can use
`mosaik init --mosaik-path /path/to/mosaik` to opt into linking a checkout.
New projects contain a pnpm runtime build allowlist and a `check` script.

From a checkout, use `pnpm install --frozen-lockfile`, `pnpm run check`, and
`pnpm exec tsx src/cli.ts ...`. Source commands load current TypeScript agent
plugins through tsx, without requiring a separate compiled checkout. The equivalent fixture and demo commands are
`pnpm run demo:fixture` and `pnpm run demo:durable`. Use a short disk-backed
`TMPDIR` when the default temporary mount is RAM-backed; long paths can exceed
Chromium's Unix socket path limit.

## One collection workflow

Start the local catalogue in a second terminal and keep its port fixed across
restarts. It contains 1,200 records, three categories, overlapping pages, and
controlled failure/layout variations.

```sh
mosaik-fixture --port 4318 --project /absolute/path/to/catalogue --no-seed
```

Configure a supported provider for **discovery only** using the usual project
`.env` or provider sign-in. Then learn a parameterized extraction:

```sh
mosaik run "Collect the requestedCount records in category from their individual detail pages. Return id, title, category and sourceUrl. Use a durable batch with deterministic page/item navigation and explicit end-of-source checks." \
  --url http://127.0.0.1:4318/catalogue --automation-id catalogue \
  --input category=books --input requestedCount=12 --browser local --headless
```

This is an opt-in live agent run; successful composition is not guaranteed. It
prints the saved source, inputs, output and an exact rerun command. For a
provider-free demonstration, restart the fixture without `--no-seed` to install
a **hand-authored fixture automation**, explicitly not an agent-discovery result.
Existing saved actions and repairs are preserved by repeated fixture setup.

Inspect the library, then select the saved automation directly with new inputs:

```sh
mosaik automations list
mosaik automations inspect catalogue --site 127.0.0.1:4318
mosaik execute catalogue --site 127.0.0.1:4318 \
  --input category=games --input requestedCount=25 --browser local --headless
```

Start a large run in a known job directory. The hand-authored fixture supports
`category=all`; an agent-generated automation should expose the same input only
if it learned that filter.

```sh
mosaik execute catalogue --site 127.0.0.1:4318 \
  --input category=all --input requestedCount=1200 --browser local --headless \
  --no-humanize --timeout 300000 --max-action-calls 6000 --job-dir ./jobs/catalogue
```

Press Ctrl-C after some records have committed. A timeout or action-call limit
also leaves committed results available. A hard process termination need not
print a final message; inspect the job afterward:

```sh
mosaik jobs inspect ./jobs/catalogue
mosaik jobs export ./jobs/catalogue
mosaik resume ./jobs/catalogue --browser local --headless --no-humanize \
  --timeout 300000 --max-action-calls 6000
mosaik jobs inspect ./jobs/catalogue --json
```

Resume restores the recorded automation, inputs and URL; it does not accept new
input values. Authentication and browser selection use the normal CLI paths.
Run from the same project, retaining `--data-dir` if originally used. Execution
limits apply to each process attempt; retry counts persist across attempts.

Verify the committed records against the independent fixture formula:

```sh
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const rows = readFileSync('jobs/catalogue/results.ndjson', 'utf8')
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
assert.equal(rows.length, 1200);
assert.equal(new Set(rows.map(row => row.id)).size, 1200);
const byId = new Map(rows.map(row => [row.id, row]));
for (let i = 1; i <= 1200; i++) {
  const suffix = String(i).padStart(4, '0');
  const id = `record-${suffix}`;
  assert.deepEqual(byId.get(id), {
    id, title: `Catalogue item ${suffix}`,
    category: ['books', 'games', 'music'][(i - 1) % 3],
    sourceUrl: `http://127.0.0.1:4318/record/${id}`,
  });
}
console.log('Verified 1200 independent records, no gaps or duplicates');
JS
```

Use `mosaik-fixture --help` for unavailable records, malformed records, temporary
503 responses, a new layout, and response delays. To try different inputs or
retry terminally failed items after changing the source, start a **new job**.
Existing completed/failed jobs do not silently reset their retry budget.

## Durable API and acceptance

New collection composition is instructed to use `ctx.batch.run`. The composition
tools accept these callbacks as per-item work and retain the durable declaration.
For discovery, `prepareComposition({durable:true,...})` preserves the navigation
capabilities needed to reconstruct each boundary. Public TypeScript API:

```ts
return ctx.batch.run({
  key: "records",
  initialCursor: startUrl,
  acceptance: {
    requiredFields: ["id", "title", "sourceUrl"],
    idField: "id",
    sourceUrlField: "sourceUrl",
    requestedCount: input.requestedCount,
  },
  retry: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 10000 },
  list: async (cursor) => {
    await openPage(ctx, { url: cursor });
    const page = await listItems(ctx, {});
    return {
      items: page.items.map((item) => ({ id: item.id, input: { href: item.href } })),
      nextCursor: page.nextUrl,
      exhausted: page.endOfSource,
    };
  },
  extract: async (item) => {
    await openPage(ctx, { url: String(item.href) });
    return readRecord(ctx, {});
  },
});
```

Action names and output fields in this example are placeholders for learned
contracts. Each callback's first browser action must begin with absolute HTTP(S)
navigation; successful observed extraction is required before committing work.
The callbacks must be deterministic with respect to their cursor/item input.
Only one batch is supported per automation run. Return its small summary;
committed rows live on disk, never in a growing worker return array.

Checks reject missing/null/empty required fields, invalid IDs, duplicate record
IDs, and non-absolute/non-HTTP(S) source URLs. Paths use dotted field names. URL
checks establish syntax, not the truth of a citation. Source exhaustion is
reported separately from reaching the requested count. Missing requested records,
any failed items/pages, and empty results without explicit `allowEmpty:true` are
incomplete. `requireExhaustion:true` also requires reaching the source end.

Non-batch saved automations can persist an `acceptance` metadata contract with
`recordsPath`, `terminationPath`, `requiredFields`, `idField`, `sourceUrlField`,
and a numeric `requestedCount` or `{input:'requestedCount'}`. Results must report
`requested-count` or `source-exhausted` at the specified termination path.
Without a contract, a successful saved execution remains **unverified/incomplete**.
Composition bypasses model outcome review when deterministic checks suffice;
`CompositionRunOptions.semanticReview:true` retains optional semantic review.

| Task status | CLI exit | Meaning                                                              |
| ----------- | -------: | -------------------------------------------------------------------- |
| complete    |        0 | Explicit deterministic acceptance passed                             |
| incomplete  |        2 | Program returned but checks/counts/termination are insufficient      |
| failed      |        1 | Execution or validation failed                                       |
| interrupted |      130 | Cancellation, timeout, or observed dead process with unfinished work |

Reports include execution success separately, collected/failed/pending counts,
failed pages, termination reason, repairs and output paths. `failures.ndjson`
contains each failed item or page and its error. `execution.json` holds the
process report. `jobs inspect --json` exposes recorded inputs, fingerprints and
accepted repairs; those files may contain extracted data and are private by default.

## Guarantees and limits

- SQLite transactions atomically commit each record and its completion marker,
  and atomically enqueue a page's IDs with its next cursor. Results deduplicate
  by stable work ID and unique record ID. A crash can repeat an **unfinished
  read**, but cannot duplicate an already committed record. A repeated item ID
  keeps its first committed input/result; this is not a live synchronization tool.
- `job.sqlite` is authoritative. NDJSON files are fsynced, atomically replaced
  snapshots refreshed at page boundaries and termination. After SIGKILL, use
  `jobs export` to refresh a potentially stale snapshot without replaying work.
- One process owns a job. Resume refuses live owners, unknown/remote owners,
  incompatible source/contracts/runtime versions, changed inputs, or unrecorded
  action edits. A dead same-host PID can be reclaimed. PID reuse is conservative
  (may refuse); automatic cross-host/network-filesystem recovery is unsupported.
- Accepted repairs are recorded with old/new fingerprints and the validated
  implementation before saving the library. Resume reconciles a crash using only
  that recorded chain. It never treats unrelated edits as a repair. Do not edit
  the library concurrently with a running job: the existing library CAS uses
  versions and cannot atomically police an external editor's same-version writes.
- This first durable API is for read-only extraction and safe local browser
  navigation/state. External side effects and uncertain outcomes cannot be
  automatically replayed. Safety depends on truthful action contracts; a website
  can assign side effects to navigation. There is no arbitrary JavaScript/browser
  continuation serialization or guarantee of a consistent snapshot of a changing site.
- In-process `ActionCheckpoint` repairs retain a live page and local continuation.
  Durable recovery opens a new browser session and navigates unfinished units.
  Completed records remain committed through an eligible repair. Provider-free
  `execute`/`resume` does not enable an agent; the TypeScript runtime accepts an
  optional caller-supplied `RepairAgent`.
- Default job ceilings: 100,000 items, 10,000 pages, 500 references/page,
  16 KiB/item input, 128 KiB/record, 256 MiB combined item-input/results budget;
  configurable limits can only lower ceilings. SQLite also has a 512 MiB main-file
  ceiling. Journal/index/WAL/export files require additional disk space. Metadata
  and repair histories are bounded. Action traces are sampled to 100 entries for
  batches with a separate exact call count. Worker output remains limited to 1 MiB
  and its old-generation heap to 64 MiB; ordinary file outputs retain their limits.
- Only classified navigation/infrastructure failures receive bounded exponential
  backoff. Invalid records, unknown errors and locator failures without an eligible
  successful repair are recorded as failures. Attempts are charged before work,
  including work interrupted by a crash. Persisted retries are never reset on resume.

## Reproduce measurements

```sh
# Installed artifact; no provider credentials or model requests.
mosaik-demo --output ./demo-results

# Contributor equivalents (use a fresh output directory).
TMPDIR=/short/disk/scratch pnpm run demo:durable --output .mosaik-bench/my-run
pnpm exec vitest run src/jobs/test/store.test.ts src/jobs/test/runtime.test.ts \
  src/jobs/test/repair-recovery.test.ts --maxWorkers=1
```

The demo really kills a child CLI process, restarts it, and compares 1,200 rows to
independent fixture data. It also changes filters, checks missing/malformed rows
and permanent/transient failures, and exercises an explicitly labeled **fake
repair agent** followed by live old/new layout regressions. A fake agent's call
count is not a model-request count. The report records durations, counts, repairs
and zero requests/tokens for deterministic scenarios; it makes no cost estimate.

`pnpm run eval:provider -- --help` describes the opt-in discovery, related-task
reuse, and real-provider locator proposal evaluation. It is not part of normal
focused tests and is not run merely by installing the package. Its outputs must
pass the fixture oracle, regardless of what the agent says. Fixture success does
not establish reliability on a live website, changing data, authentication flows,
CAPTCHAs, or untested layouts.

## Recorded local validation

The [measured fixture report](evaluations/durable-local.json) ran on Node 24.18.0
and Playwright 1.62.1, with one active browser. Total duration was **166.056 s**:

| Scenario                                         | Verified output                                              |  Duration | Model requests |
| ------------------------------------------------ | ------------------------------------------------------------ | --------: | -------------: |
| SIGKILL after 60 commits, restart                | 1,200 records, no gaps/duplicates or committed-item replay   | 152.237 s |              0 |
| Same saved automation, books filter              | 25 correct records                                           |   4.112 s |              0 |
| Same saved automation, games filter              | 25 correct records                                           |   3.872 s |              0 |
| Permanent/transient failures and malformed data  | 10 valid, 2 failed; incomplete                               |   1.353 s |              0 |
| Request 15, source contains 12                   | 12 valid; incomplete, source exhausted                       |   1.076 s |              0 |
| Simulated locator repair and old/new regressions | 12 correct; 1 fake-agent repair, 5 earlier commits preserved |   3.292 s |              0 |

The [installed-artifact check](evaluations/package-local.json) passed in 11.320 s
using the copied repository dependency snapshot and cached packages. It verified
installed assets/types/init and eight actual extracted records with zero model
calls. Lifecycle scripts were disabled for this isolated check; native provider
subprocess behavior and live-provider outcomes were not measured. An unrestricted
fresh dependency resolution did not finish within the check's time limit.

To check a prepared tarball reproducibly without linking the checkout:

```sh
TMPDIR=/short/disk/scratch pnpm run package:check /absolute/path/mosaik-0.1.0.tgz \
  --lockfile=/absolute/path/to/pnpm-lock.yaml
```

Omit `--lockfile` to test fresh dependency resolution; add `--online` if the cache
is incomplete. Release preparation uses the package's existing prepack pipeline;
normal development verification uses `pnpm run check`, not `pnpm run build`.
No package was published during this validation.

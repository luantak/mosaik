# Learn once, run again: book catalogue

This example runs Mosaik twice against the first page of
[Books to Scrape](https://books.toscrape.com/). The first run discovers a
read-only action and composes a TypeScript automation. The second run repeats
the **same task** in a fresh CLI process and checks that the automation executes
without discovering another action. `verify.mjs` checks both results and writes
a report alongside the five extracted records.

From the repository root, with Node >=22.18, pnpm, a Chromium installation,
and an `OPENCODE_API_KEY` in your environment:

```sh
pnpm install --frozen-lockfile
pnpm run build # needed to run the CLI from this checkout
node dist/cli.js doctor --json
node examples/books-catalogue/run.mjs
```

The optional arguments are `[model] [new-workspace-directory]`. The default
model is `opencode-go/gpt-5.6-luna`; each invocation creates a new directory
under `examples/books-catalogue/.runs/`. Do not put API keys in the project or
commit `.runs/`. The script initializes a linked Mosaik project, invokes the
same CLI command twice, and fails if either run is incomplete, the returned
records differ, the first run learns nothing, or the second discovers a new
action. Inspect these files inside the printed workspace:

- `first.json`, `second.json`: complete CLI results, including metrics and run paths.
- `report.json`, `books.json`: checked summary and extracted records.
- `sites/books.toscrape.com/actions/` and `automations/`: the generated TypeScript.
- `.mosaik/runs/`: full traces for investigating failures.

To check results from runs you already have:

```sh
node examples/books-catalogue/verify.mjs FIRST.json SECOND.json
```

## What the observed run showed

On one live test with `opencode-go/gpt-5.6-luna` and local headless Chromium,
both runs completed with five records and the same saved action call. The first
run discovered one action and took 124.4 seconds with 9 model requests. The
second discovered none and took 16.1 seconds with 1 model request. These are
observations, **not a benchmark or promised speedup**. The second CLI run still
uses a model for outcome review. Its saved automation execution does not need
a composition call.

The site's catalogue abbreviates some visible book titles. The learned action
reads that displayed text, so `books.json` contains shortened titles for those
books. This demo checks what was extracted; it does not claim full bibliographic
titles. It only covers five records on one page and does not test pagination,
login, locator repair, or thousands of records. Generated TypeScript is worth
inspecting before reuse on another site. CLI-generated source in this run did not
pass the initialized project's `pnpm run check`, so direct import is unverified.
This is tracked in [issue #16](https://github.com/luantak/mosaik/issues/16).
The demo proves CLI reuse, not application-import support.

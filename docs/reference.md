# Mosaik reference

Setup, runtime details, authentication, and deployment. For the tldr;
start with the [README](../README.md).

## Install the CLI

Mosaik ships a `mosaik` executable. To install the current checkout for
the active Node installation:

```sh
pnpm install
pnpm run build
pnpm add --global .
mosaik setup
mosaik doctor
```

Mosaik requires Node 22.18 or newer. `mosaik setup` installs Playwright's
Chromium build.

`mosaik doctor` checks the installed command, Node.js, DSH, bundled runtime
files, Chromium, provider credentials, and the data directory. Failed checks
include the exact repair command. Use `mosaik doctor --json` in scripts and
CI.

Run `mosaik` with no arguments in an interactive terminal to start an agent
session. Mosaik first asks for a URL and immediately opens it in a persistent
browser profile. Enter browser tasks at the prompt and keep sending more tasks
in the same session. One browser session is one run. Enter sends a prompt,
Shift+Enter adds a newline, and Ctrl+C cancels the active prompt without closing
the browser. Left and Right move the input cursor, while Up and Down move across
multiline input or recall single-line history. Run `login` or `/login` with no
arguments to log in on the current page, or `/new` to close the current run and
return to the start-URL prompt. `/help` lists the other interactive commands.
Type `/` and use Up or Down to select a command. Mosaik keeps completed prompts
and tool output in normal terminal scrollback, and the footer shows the current
session ID. In a pipe or other non-interactive shell, the same command prints
ordinary help instead.

The executable can run from any directory. Start a project with
`mosaik init`, which creates a pnpm TypeScript package linked to this
Mosaik checkout so `mosaik/actions` and `mosaik/automations` resolve.
It reads `.env` and stores learned action metadata, authentication records,
browser profiles, and run data under `.mosaik` in the current directory.
Editable TypeScript sources live in the project itself:

```text
sites/<site>/actions/<actionName>.ts
sites/<site>/automations/<automationId>.ts
.mosaik/sites/<site>/actions/<actionId>.json
.mosaik/sites/<site>/automations/<automationId>/current.json
```

Automations import actions (and other automations) with ordinary relative imports.
Interactive sessions live under `.mosaik/runs/<run-id>/`; prompt traces are
nested under `prompts/`, while generated data files are confined to that run's
`output/` directory. Pass `--data-dir` to put persistent state elsewhere.

Before reusing learned actions, composition represents a prompt as workflow
stages with optional page context, per-item cardinality, and dependency edges.
Only explicit ordering and data dependencies constrain the graph; independent
stages remain reorderable. Learned actions from one context, such as a listing,
do not satisfy a stage constrained to another context, such as an item detail
page, merely because their output schemas match.

Automations save strings and JSON with `ctx.files.write(path, data)`. They save
linked files with `ctx.files.download({ url, path })`. Downloads reuse response
bytes Chromium already loaded. On a cache miss, Mosaik loads same-origin URLs
through the current browser context so cookies and login state apply. Set
`reuseOnly: true` to forbid that fallback. Duplicate filenames become
`name-2.ext`, `name-3.ext`, and so on; `onConflict: "error"` makes collisions
fail instead. Downloads accept only absolute HTTP(S) URLs, stay inside the
current run's output directory, and remain subject to file-count and byte
limits.

Set `OPENROUTER_API_KEY` in the environment or the current directory's `.env`,
then run a task:

```sh
mosaik run "Search for ceramic mugs" \
  --url https://example.com \
  --input query=mug
```

Inputs use repeatable `--input key=value` flags. JSON numbers, booleans,
objects, and arrays are decoded as their JSON types. Use
`--input-json '{"query":"mug","maxPrice":20}'` for a full object and `--json`
for machine-readable output.

Pass `--humanize` to change interaction delivery without changing the generated action plan.
Set a project default with `mosaik config set humanize true`; `--no-humanize` overrides it for
one run. The setting applies to local and Kernel browser sessions. A deployed Kernel app accepts
`"humanize": true` in its run payload.

When a task needs a new site action, Mosaik learns and saves the action, then
executes the generated automation in the same run. Inspect the current library
with:

```sh
mosaik actions list
mosaik actions list --site example.com --json
```

Run `mosaik --help` or `mosaik <command> --help` for all options.

## Kernel browsers and deployment

Mosaik can create a Kernel browser and connect to it from the local CLI over
Chrome DevTools Protocol. Set `KERNEL_API_KEY` and `OPENROUTER_API_KEY`, then add
`--browser kernel` to an ordinary run:

```sh
mosaik run "Read the page heading" \
  --url https://example.com \
  --browser kernel \
  --headless
```

Use `--kernel-profile <name>` to load a Kernel profile and save its changes,
`--kernel-stealth` to enable stealth mode and CAPTCHA solving, and
`--kernel-timeout <seconds>` to change the 300-second inactivity timeout. The
local Kernel CLI's OAuth login does not supply credentials to the TypeScript
SDK; local `mosaik run` needs `KERNEL_API_KEY`. Library callers that already
have a CDP WebSocket URL can pass it to `connectBrowserSessionOverCdp` instead.

Kernel Managed Auth owns remote login. Mosaik only receives a connection ID and
the temporary hosted URL. It never receives a username, password, one-time code,
or credential reference:

```sh
mosaik login https://example.com/login --browser kernel
mosaik run "Read my account" --url https://example.com --browser kernel
```

The command saves the connection ID and generated profile name in
`.mosaik/config.json`. Set the project default once with
`mosaik config set browser kernel`, then both commands can omit `--browser`.
Use `--no-open` to copy the hosted URL to another machine, `--no-wait` to start
the flow and exit, or `--json` for a single machine-readable start result.
`--kernel-auth-connection` is an explicit run override. `--kernel-profile` is
the legacy trusted-profile override and does not check Managed Auth status.

The host must authorize that the connection belongs to the application user
before invoking a deployed `mosaik run` action. A connection ID is a reference,
not an authorization check. Serialize runs that use one auth connection because
Kernel profiles save cookie and token changes when the browser closes.

Kernel's deployment builder accepts the root entrypoint in `kernel-app.ts`.
Build the embedded DSH child-process plugins and deploy from the repository root:

```sh
pnpm run build
kernel deploy kernel-app.ts --version latest --env-file .env
kernel invoke mosaik run --version latest --async-timeout 300 \
  --payload '{"task":"Read the page heading","url":"https://example.com","headless":true}'
```

Projects created with `mosaik init` can deploy their own canonical `sites/`
library directly from the project root:

```sh
mosaik kernel deploy --version mosaik-test
```

The command packages `sites/<site>/actions/*.ts` and
`sites/<site>/automations/*.ts`, reads `.env`, and invokes the Kernel CLI. It does
not include old root-level automations. The default Redis namespace is derived
from the package name, such as `mosaik:mosaik-test`, so projects that share one
Redis instance remain isolated. Use `--namespace`, `--env-file`, `--project`,
or `--force` when an override is needed.

Remote learning can be brought back into any local Mosaik project without
coupling the synchronization command to Kernel:

```sh
mosaik pull
```

`mosaik pull` reads the configured `REDIS_URL` or `MOSAIK_LIBRARY_URL`, uses the
same package-derived namespace as deployment, and writes canonical
`sites/<site>/actions/*.ts` and `sites/<site>/automations/*.ts` files. It never
recognizes old root-level automations. Local-only records are preserved, and a
remote record that differs from the same or a newer local version is reported
as a conflict. Inspect changes with `--dry-run`; use `--force` only when the
remote record should replace the conflicting local record. `--site` limits the
operation to one site.

The deployment needs `OPENROUTER_API_KEY`; Kernel injects its own API key into
the action. The `run` action accepts `task`, `url`, optional `inputs`, `siteId`,
`automationId`, `model`, `headless`, `stealth`, `authConnectionId`, and the legacy
`profileName`. It creates a
browser associated with the invocation, routes nested DSH discovery processes
to that browser's CDP endpoint, executes newly learned code in the same
invocation, and deletes the browser afterward.

Kernel invocation files are ephemeral. `pnpm run build` embeds the project-local
`sites/` action and automation sources into the deployment, and each invocation
materializes that seed library before composition. `pnpm run kernel:assets`
checks that the embedded plugins still compile.

To keep learned actions and automations across invocations, attach a Redis service
and expose its connection string as `REDIS_URL`. Railway Redis uses that name,
so a linked Railway variable needs no translation. `MOSAIK_LIBRARY_URL` takes
precedence when both variables exist. An optional
`MOSAIK_LIBRARY_NAMESPACE=mosaik:production` lets several deployments share one
Redis instance without sharing libraries.

Mosaik validates remote records before materializing them and uses atomic
version checks for writes from concurrent invocations. The `run` result reports
`persistence.mode` as `redis` with loaded, written, and conflict counts. Without
a Redis URL it reports `ephemeral` and keeps the current invocation-only
behavior.

## Architecture

```text
natural-language task
  -> CapabilityCompositionAgent
  -> site capability inspection and reuse planning
  -> ReusableActionDiscoveryAgent for missing actions only
  -> persisted compiled site actions (`.ts` + IR metadata)
  -> persisted Mosaik TypeScript automations
  -> DSH worker-thread automation execution
  -> semantic Playwright steps
  -> shared replace-locator repair when eligible
```

Core types, capabilities, persistence, browser runtime, and repair do not import
DSH. DSH agent adapters live under `src/agents/dsh`. Generated automations run
through `@deepseek-ai/dsh-code-runtime-worker-thread`; `src/automations/sandbox.ts`
is the one deterministic package allowed to import DSH. Mosaik exposes
registered actions as the runtime's static binding namespace and validates
action names, schemas, source syntax, execution time, and action-call counts on
the host.

Authentication is a separate host-side handoff. Mosaik opens the login page
and deterministically discovers standard login fields before it invokes a
trusted interactive prompt. The prompt's returned username, password, or
one-time code is filled directly into Playwright and is not added to composition
inputs, model prompts, agent subprocess environments, run events, or failure
artifacts.

The public entry point is `composeAndRun` in `src/composition/index.ts`. It
accepts a task, site ID, start URL, and input values. Callers do not provide
capability needs, Code Mode source, automation source, or action lists.

Live composition puts the already-inspected capability summaries and schemas in
the initial model context. A full-reuse task writes and persists its automation
with one model-authored Code Mode execution. When navigation is unknown,
`inspectNavigation` returns page identity, headings,
landmarks, and observed absolute links in a separate planning browser. It follows
only the start URL, links it has observed, or structured navigation evidence
carried into recovery. These observations create no saved
actions or execution stages. Required navigation and state changes remain in the
automation, as does collection when live results select destinations or the user
explicitly requires it.

Once execution needs are known, `prepareComposition` discovers missing actions.
The next response uses the returned typed contracts to write static Mosaik
TypeScript and calls `finishComposition` without repeating the needs. The host
retains the exact prepared workflow and still validates every required stage.
Full reuse without preparation supplies needs directly.
Composition uses low reasoning; action discovery uses medium reasoning by default. Discovery receives the initial loaded-page
overview in its first model context.

After successful execution, a separate model step reviews the original request,
returned data, action results, and file metadata. It delivers a grounded answer
or reports the missing evidence. A successful automation execution alone does not
mark the task complete. Empty results can satisfy a no-match query, but cannot
answer a research question without supporting evidence.

When discovery already supplies a simple navigation-and-reading result, outcome
review uses those observations without replaying the saved automation. Automations
with loops, downloads, transformations, or other runtime work execute once to
finish the requested task. Actions learned during that invocation remain
unverified until a later successful reuse; task execution is not a separate
verification replay. Insufficient discovery-only evidence is reported without
an automatic automation replay.

For tasks executing existing actions, an incomplete outcome allows up to three recovery attempts using the observed
results, links from the execution page, and remaining budgets. Repeated evidence
stops recovery early. Mosaik does not automatically replay external side
effects or actions with unknown safety. The final result keeps execution success
separate from task completion, records the attempts, and exposes `answer` for
the CLI. Review and recovery share the default budget of 30 model requests,
30 Code Mode executions, and 160 nested tool calls. Each automation execution has
a three-minute timeout.

For a missing action, the same discovery context runs the model-selected,
already-registered prerequisite actions before model exploration. If the model
omits that prefix, the host may recover one uniquely bindable registered search
action from the inspected library. It does nothing when the choice is ambiguous.

## Maturity

This is an alpha research implementation with file-backed persistence and local
fixture coverage. It supports per-site reuse, typed action contracts, validated
TypeScript control flow, action repair, compatibility versions, and host-mediated
form login with agent-inferred success checks. It
does not support passkeys, CAPTCHA, arbitrary SSO or popup flows, payments,
destructive workflows, anti-bot behavior, cross-site reuse, distributed
execution, a database, or a web UI.

## Authentication

For Kernel browsers, use the hosted login path described above. The local flow
below keeps credentials in a local Chromium profile and is separate from Kernel
Managed Auth.

The caller owns the browser session and the trusted credential prompt.
`loginWithBrowserSession` first navigates to the login URL, discovers the
visible form without reading its values, and only then calls the prompt adapter.
It supports multi-page username, password, and one-time-code forms. Login
requires a persistent Chromium profile.

After the last login step, the CLI sends the authenticated page title, body
text, URL, login-form status, and a bounded set of marker candidates to
`DshAuthSuccessAgent`. The host redacts every entered credential value before
creating that request. The agent decides whether login succeeded and may select
one supplied account-specific marker. It cannot invent a selector or use
ordinary page content such as a table row. Mosaik checks that condition on
the page produced by the login. It does not open another tab or repeat the
navigation. An explicit `--check-url` navigates that same tab before the final
check.

For a local dev server, start the server in one terminal and run the login CLI
from another:

```sh
mosaik login http://localhost:3000/login --pause
```

The command opens Chromium before asking for credentials. The agent infers the
authenticated URL and a stable signed-in marker such as a user menu or logout
control. Mosaik stores the browser-managed profile under
`.mosaik/browser-profiles/localhost-3000`. Login, verification, and `--pause`
use one tab in one persistent Chromium session. The CLI does not close and
reopen the profile between those steps, so browser-session cookies stay valid.
It does not export cookies into a separate JSON file.

The CLI also writes the entered username and password as raw JSON to
`.mosaik/browser-profiles/localhost-3000/.mosaik-credentials.json`. A
later CLI run reuses those values if the saved browser profile starts on the
login form. This covers local services that discard their session cookie when
Chromium closes.

One-time codes are always requested interactively and are never saved. If saved
credentials are rejected and the same form appears again, the CLI asks for
replacements and updates the file. `--pause` leaves the final verified page open
until you press Enter. Run `mosaik login --help` for every option.

The first successful run saves a typed authentication automation to
`.mosaik/auth-automations/auth-localhost-3000-login/current.json`. This uses
the same versioned `current.json` repository layout as Mosaik's other saved
automations. The record contains the ordered login pages, field
metadata, submit labels, and final success condition. It never contains
credential values.

Later runs rediscover each live form, replay stored email and password values
through the trusted credential adapter, and request a fresh OTP when needed.
They test the saved URL, login-form state, and optional account marker on the
page produced by login. A matching condition skips the model call. If the site
changes, Mosaik records the new steps. If the final condition no longer
matches, the CLI calls the agent once and updates the automation. The old
profile-local success-check file is accepted as a migration source.

Local `mosaik run` and interactive sessions use this same per-origin browser
profile. When the start page presents a login form, Mosaik replays the saved
authentication automation before composition starts, then returns to the
requested URL. Authentication records stay separate from learned site actions
because credential values are supplied by the trusted credential adapter, not
passed through an agent-authored automation. In interactive mode, both `login` and
`/login` invoke this authentication flow instead of composing a site action.

The CLI needs `OPENROUTER_API_KEY` in the environment or the repository's `.env`
when it has no usable saved authentication check. Set `MOSAIK_AUTH_MODEL` to
override the default `openai/gpt-5.6-luna:nitro` model. When the agent runs, its
DSH session log under `.mosaik/runs/` contains the redacted
authenticated-page evidence sent to the model.

Use the same hostname in the login and check URLs. Browser storage treats
`localhost` and `127.0.0.1` as different origins.

To test a three-page email, password, and OTP flow, start the bundled fixture in
one terminal:

```sh
pnpm run auth:fixture
```

It listens on `http://127.0.0.1:4317` and prints the test credentials. In
another terminal, run:

```sh
mosaik login http://127.0.0.1:4317/login --pause
```

The first run asks for email, password, and OTP. Close it with Enter, then run
the same command again. Mosaik reuses email and password, asks only for a
fresh OTP, and loads
`.mosaik/auth-automations/auth-127.0.0.1-4317-login/current.json` without
another model call. Set `MOSAIK_AUTH_FIXTURE_PORT` if port 4317 is occupied.

The same flow is available as an API:

```ts
import {
  createProfileCredentialPrompter,
  createTerminalCredentialPrompter,
  DshAuthSuccessAgent,
  loginWithBrowserSession,
  openBrowserSession,
} from "./src/index.js";
import { executeAutomation } from "./src/runtime/index.js";

const profileDirectory = ".mosaik/browser-profiles/example";
const session = await openBrowserSession({
  profileDirectory,
  headless: false,
});

try {
  await loginWithBrowserSession(session, {
    loginUrl: "https://example.com/login",
    prompter: createProfileCredentialPrompter(profileDirectory, createTerminalCredentialPrompter()),
    successAgent: new DshAuthSuccessAgent(process.cwd()),
  });

  const result = await executeAutomation(session, automation);
} finally {
  await session.close();
}
```

For work that does not need login, omit `profileDirectory`. Every call gets a
fresh browser context and Mosaik discards its state afterward:

```ts
const session = await openBrowserSession();
try {
  const result = await executeAutomation(session, automation);
} finally {
  await session.close();
}
```

The bundled terminal prompt requires a TTY and prints one `*` for each password
or one-time-code character typed or pasted. This provides visible feedback
without echoing the secret. `createProfileCredentialPrompter` places a trusted
file-backed layer in front of it. A server or application can instead implement
`CredentialPrompter` with its own trusted, non-model input channel. Do not pass
credentials through `composeAndRun(..., { inputs })` or any agent-backed prompt
adapter.

Library callers can pass a persistent `BrowserSession` to the composition agent
when they need authenticated composition. The local CLI creates that session
from the matching per-origin profile and applies saved authentication before
composition or discovery starts.

### Persistent profile limitation

The Chromium profile contains cookies, local storage, IndexedDB, service
workers, cache data, and other browser state. The login CLI also stores raw
usernames and passwords in `.mosaik-credentials.json` inside that profile.
Neither the browser data nor the credential file is encrypted. Anyone who can
read the directory can recover the credentials and may be able to impersonate
the account. Authentication automation records live under
`.mosaik/auth-automations/` and contain no credential values.

Mosaik creates the profile directory with mode `0700` and the credential file
with mode `0600` on systems that honor POSIX modes. Windows relies on inherited
ACLs. `.mosaik/` is gitignored. These permissions reduce accidental access
but do not protect against another process running as the same user, a
privileged administrator, backups, or disk theft.

Treat the profile like a password. Never commit, upload, or place it in a shared
directory. Chromium locks a profile while it is open, so only one process should
use a given directory at a time.

Cookies without an expiry are browser-session cookies. Chromium may remove them
when the persistent context closes. The CLI now keeps one `BrowserSession` open
through login, verification, and `--pause`. Callers should do the same for the
full authenticated task. Cookies with an expiry and origin storage survive
profile reopen normally. A later CLI run restores a logged-out session from the
saved credentials. No separate service is required.

## Commands

```sh
pnpm test
pnpm run check
pnpm run build
pnpm run lint
pnpm run fmt
```

Deterministic tests use fake agents or local semantic tools and need no model
credentials.

## Safety limits

An `external-side-effect` step changes something outside the browser, such as
placing an order, sending a message, or deleting a record. The action author
sets this classification explicitly; Mosaik does not infer it from a click.
Normal execution can run these steps. Automatic repair stops if the failed step
has this classification, or if validating a pending repair would reach one.
The execution result reports `requiresApproval: true` so the caller can decide
what to do next. Enabling repair on an instance does not bypass this policy.
Outcome recovery also avoids replaying tasks that attempted these actions.

Locator repair remains limited to `replace-locator`. Automation execution enforces
time and action-call budgets.

### Code execution trust

The selected DSH worker runtime provides fresh-worker isolation, an empty
environment, heap and output caps, compute and wall-time budgets, abort
handling, and JSON-only host bindings. It is containment, not a security
boundary. DSH documents this backend as having bash-equivalent trust. Ambient
Node capabilities may be reachable through indirect JavaScript even though
Mosaik rejects direct references to imports, `require`, `process`,
filesystem, network, dynamic code, raw Playwright, and dynamic action names.

Use this configuration only for trusted model-generated automations. Before
accepting adversarial tasks or prompt-injected source, replace the worker-thread
`CodeRuntime` with a process or container implementation that enforces the
required filesystem and network policy. The static validator remains a
correctness and policy check, not a sandbox.

## Import generated automations

Newly generated automations are directly callable from a Node TypeScript application.
Inputs and return values retain their inferred TypeScript types:

```ts
import { createMosaik } from "mosaik";
import searchProducts from "./sites/example.com/automations/searchProducts.js";

const mosaik = await createMosaik({ headless: true });
try {
  const products = await searchProducts(mosaik, { query: "ceramic mugs" });
  console.log(products);
} finally {
  await mosaik.close();
}
```

Automations use `defineAutomation(import.meta.url, async (ctx, input: { ... }) => { ... })`.
Annotate the input parameter and let TypeScript infer the return type. Both default
and named automation exports work; each module exports one automation. Automations call
imported actions and other automations with `ctx` as the first argument.

The first call reads and prepares the source for the existing worker sandbox in
memory. No separate Mosaik build command or metadata directory is needed. Keep the
site's `automations/` and `actions/` sources together. Each call checks dependency
contents and reuses unchanged parsed sources. Automations may import sibling automations
one level deep; cycles and imports outside the site are rejected. Your application
still needs its normal TypeScript execution support, such as `tsx`.

`createMosaik` accepts `startUrl`, `profileDirectory`, `timeoutMs`, `maxActionCalls`,
`outputDirectory`, `repair`, `humanize`, and an abort `signal`. `humanize: true` changes only
runtime interaction delivery: mouse paths use `ghost-cursor`, scrolling and typing are paced,
and browser waits may include bounded cursor movement. Generated steps and saved source stay
the same. To reuse an authenticated browser, pass
`session`; the caller retains ownership of that session and closes it separately.
Calls on one instance execute sequentially. `close()` waits for accepted calls and
rejects new calls. Execution failures throw `MosaikExecutionError`, whose `result`
contains runtime logs, action calls, and failure details. Repair is disabled by default. Set `repair: false` explicitly or pass
`repair: { agent: repairAgent }` to enable live repair with a caller-supplied
`RepairAgent`, exported from `mosaik`. The agent implements `generateRepair`
and can implement `generateLiveRepair` to inspect the active Playwright page.
Mosaik prefers the live method when available. It validates proposed changes
and resumes at the failed step, without replaying completed steps.

Accepted repairs stay in the instance's memory for subsequent calls. Editing an
action's source invalidates that cached repair. Source files are not rewritten.
The existing repair eligibility and approval rules still apply. A failed or
refused repair throws `MosaikExecutionError` with the execution details.

Only JSON-compatible data crosses the worker boundary. The Mosaik instance and
browser remain in the host process. As with other Mosaik execution, the worker is
containment for trusted generated code, not a security boundary against hostile
code. Normal JavaScript imports evaluate module-level code in the host, so imported
modules must be trusted and keep automation logic inside the handler. Existing
automations using the one-argument `defineAutomation(handler)` form need the
`import.meta.url` argument before they can be called through an instance.

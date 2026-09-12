# Mosaik

Browser automation built from small, reusable pieces.

When you're reading thousands of records, you need to apply the same rules to
each one. When you're checking a complete user journey, you need to repeat it
after the next release. Mosaik saves the steps as code so the workflow stays
the same between runs.

An agent figures out how a site works, saves reusable actions as TypeScript, and
composes them into automations. Playwright executes the browser steps
deterministically. Loops, branching, and data transformations run as code without
a model decision for each iteration. Each run has limits on execution time and
action calls.

Mosaik reuses saved actions for later tasks on the same site and learns any
missing actions. If an eligible locator breaks, an agent can repair it.

We're still working toward dependable runs at that scale. Mosaik is alpha
software, and we're changing things freely. Expect bugs and breaking changes.

We're building it for tasks like these:

- Gather research data from thousands of records, extracting the same fields
  with consistent rules. The dataset is hard to trust if the interpretation
  changes halfway through.
- Check a whole website for missing images or incorrect prices. Apply the same
  checks to page 8,000 as page 1, and account for pages that couldn't be checked.
- Verify that someone can find a course, select a date, and reach registration,
  then repeat the workflow after a release. Checking the homepage alone won't
  catch failures in the rest of the journey.

## Try it

Mosaik currently supports GPT-5.6 Luna through OpenRouter or your Codex
subscription.

Pick the provider with `mosaik run --model …` or `/model` in the interactive CLI.

You'll need Node 22.18 or newer, pnpm, and either an OpenRouter API key or a
Codex sign-in.

Clone this repo and install the CLI:

```sh
git clone https://github.com/luantak/mosaik.git
cd mosaik
pnpm install
pnpm run build
pnpm add --global .
mosaik setup
mosaik doctor
```

`setup` installs Chromium and fetches Camoufox. `doctor` checks the installation
and tells you what needs fixing, including missing provider credentials.

Create a directory for your automations. `mosaik init` makes a TypeScript project
linked to your Mosaik checkout:

```sh
mkdir my-automations
cd my-automations
mosaik init
export OPENROUTER_API_KEY=your-key
# or: mosaik provider login
mosaik
```

You can also put the OpenRouter key in this directory's `.env` file. Codex
stores its grant in `~/.dsh` after `mosaik provider login`.

The interactive CLI will ask for a URL. Enter:

```text
https://books.toscrape.com/
```

Once the browser opens, give it this task:

```text
download the first 100 book covers
detail page separately.
```

Downloaded covers go into `.mosaik/runs/<run-id>/output/`. The actions and automation
Mosaik learns stay in your project for reuse.

Keep sending tasks in the same session. `/login` starts the login flow on the
current page, `/new` starts a fresh run, and `/help` lists the commands. Ctrl+C
cancels the current prompt without closing the browser.

## What you get to keep

Learned actions and composed automations live in your project as editable
TypeScript:

```text
sites/<site>/actions/<actionName>.ts
sites/<site>/automations/<automationId>.ts
```

Automations import actions with normal relative imports. You can read the code,
change it, commit it, and call a saved automation from your own application:

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

Set `humanize: true` to use curved `ghost-cursor` mouse paths, paced scrolling,
variable typing, and occasional cursor movement during browser waits in place
of direct Playwright interactions. The generated automation stays unchanged.
This is Mosaik runtime humanization, not Camoufox-native cursor motion
(`camoufox.humanize`):

```ts
const mosaik = await createMosaik({ headless: false, humanize: true });
```

For the CLI, pass `--humanize` for one run or save it as the project default:

```sh
mosaik config set humanize true
mosaik run "Search for ceramic mugs" --url https://example.com
```

`--no-humanize` overrides the project default. Humanization happens during browser
execution, so it adds no composition or discovery steps and leaves saved action
and automation source unchanged.

The application example assumes you've already generated `searchProducts` for your site.
Inputs and return values keep their inferred TypeScript types. By default, a
saved automation runs without model calls. To let an agent repair eligible failures,
pass your repair agent when creating the instance:

```ts
const mosaik = await createMosaik({
  headless: true,
  repair: { agent: repairAgent },
});
```

`repairAgent` implements Mosaik's `RepairAgent` interface. Set `repair: false`
to disable repair explicitly. Successful repairs stay in memory for later calls
on this instance. They don't rewrite your source files.

Mosaik keeps metadata, browser profiles, and run traces in `.mosaik/`. Files an
automation writes or downloads go into the run's `output/` directory. To see what
it's learned so far:

```sh
mosaik actions list
```

## How it works

For a new task, the composition agent checks the site's saved actions to see
which ones it can reuse. If an action is missing, an agent discovers it. Mosaik
then validates the TypeScript automation and runs it through Playwright, with
limits on execution time and action calls.

An automation can finish without an error and still leave the task incomplete.
A separate model step checks the results against the original request and can
report missing evidence. Runs using existing actions can attempt recovery within
set limits.

Clicking "Place order" spends money; clicking "Send" contacts another person.
Mosaik calls these `external-side-effect` steps, and
action authors mark them explicitly. Normal execution can run them, but repair
won't automatically retry them or continue through one while validating a fix.
Outcome recovery also won't replay a task that already attempted one. Buying
something twice because a locator changed would be a pretty bad repair.

Reuse is per site. An action learned on one shop doesn't automatically work on
another, and a changed page can still break things. Repair currently handles
eligible locator replacements. It doesn't yet handle other kinds of failure.

## Login and remote browsers

For a local browser, start with:

```sh
mosaik login https://example.com/login --pause
```

Mosaik supports multi-page username, password, and one-time-code forms. Later
runs reuse the site's browser profile and saved login flow.

The local CLI saves usernames and passwords as unencrypted JSON inside
`.mosaik/browser-profiles/`. It doesn't save one-time codes. Treat that directory
like a password and keep it out of git and shared folders. Credentials go through
a trusted prompt, not through task inputs. The [authentication reference](docs/reference.md#authentication)
explains the flow and its limits.

Mosaik can also use [Camoufox](https://camoufox.com/) instead of local
Chromium. Set `--browser camoufox` or `mosaik config set browser camoufox`.
Mosaik owns the fingerprint options and maps them onto camoufox-js.
`--humanize` still uses mosaik's `ghost-cursor` path; optional
`camoufox.humanize` is a separate Camoufox-native knob and stays off by
default. Camoufox profiles live under `.mosaik/camoufox-profiles/`,
separate from Chromium. See the
[Camoufox guide](docs/reference.md#camoufox-browsers).

Mosaik can also use Kernel browsers. Set `KERNEL_API_KEY` and add
`--browser kernel` to a run. Kernel login uses its hosted Managed Auth flow.
You can deploy a project's action library to Kernel and use Redis to keep new
learning across invocations. The commands and setup are in the
[Kernel guide](docs/reference.md#kernel-browsers-and-deployment).

## Still rough

This is an early research implementation. Local login doesn't cover arbitrary
SSO, passkeys, or popup flows. Payments and destructive workflows aren't
supported. There's no web UI.

Generated code runs in a DSH worker with validation and resource limits, but
that worker is not a security boundary against hostile code. Use it for trusted
automations. A deployment accepting adversarial tasks needs stronger process or
container isolation. See [code execution trust](docs/reference.md#code-execution-trust).

## Contributing

Try Mosaik on a site you care about and tell us where it breaks. Ideas, bug fixes,
and clearer docs are welcome, whether you open an issue or send a PR. You don't
need to understand the whole codebase to contribute.

Join us on [Discord](https://discord.gg/QmspQUZ3Ec) to ask questions, share what
you're building, or talk through a contribution.

If you're working on Mosaik itself, `pnpm run check` checks types,
`pnpm run fmt` formats the code, and `pnpm run lint` runs the linter.
Deterministic tests use fake agents or local tools and don't need model keys.

The [reference](docs/reference.md) has the rest, including architecture details,
file downloads, authentication internals, and the automation API.

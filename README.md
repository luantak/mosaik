# Mosaik

Browser automation built from small, reusable pieces.

Reading thousands of records or checking a complete user journey takes consistent
execution. We want to run the same steps across every page and repeat them next
week. Mosaik saves those steps as code so the workflow stays the same between runs.

Mosaik uses an agent to figure out how a site works, saves reusable actions as
TypeScript, and composes them into automations. Playwright executes the browser
steps deterministically. Loops, branching, and data transformations run as code,
so each iteration doesn't need another model decision. Execution time and
action-call budgets still bound each run.

Those actions stay around for the next task. Mosaik reuses what it knows about
the site and learns what's missing. If an eligible locator breaks, an agent can
step in to repair it.

Dependable runs at that scale are what we're working toward. This is still alpha
software, and we're changing things freely. Expect bugs and breaking changes.

Some tasks we want this to be good at:

- Gather research data from thousands of records, extracting the same fields
  with the same rules all the way through. Changing the interpretation halfway
  through makes the dataset hard to trust.
- Check a whole website for missing images or incorrect prices. Apply the same
  checks to page 8,000 as page 1, and account for pages that couldn't be checked.
- Verify a complete user journey. Can someone find a course, select a date, and
  reach registration? Run that workflow again after a release and check that
  every step still works. A working homepage doesn't tell you much about the rest.

## Try it

The default model is `openai/gpt-5.6-luna:nitro` through OpenRouter, used for
composition, action discovery, and outcome review. This is the model we've
tested with. You can choose another with `mosaik run --model <model>`, but expect
some breakage when switching models. Login checks default to the same model and
can be overridden separately with `MOSAIK_AUTH_MODEL`.

You'll need Node 22.18 or newer, pnpm, and an OpenRouter API key.

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

`setup` installs Chromium. `doctor` checks the installation and tells you what
needs fixing, including a missing API key.

Create a directory for your automations. `mosaik init` makes a TypeScript project
linked to your Mosaik checkout:

```sh
mkdir my-automations
cd my-automations
mosaik init
export OPENROUTER_API_KEY=your-key
mosaik
```

You can also put the key in this directory's `.env` file.

You're now in the interactive CLI. When it asks for a URL, enter:

```text
https://books.toscrape.com/
```

Once the browser opens, give it this task:

```text
download the first 100 book covers. Move through the catalog with Next; don't open each book's
detail page separately.
```

Downloaded covers go into `.mosaik/runs/<run-id>/output/`. The actions and automation
Mosaik learns stay in your project for reuse.

Keep sending tasks in the same session. `/login` starts the login flow on the
current page, `/new` starts a fresh run, and `/help` lists the commands. Ctrl+C
cancels the current prompt without closing the browser.

## What you get to keep

The useful part is what remains after a run. Learned actions and composed
automations live in your project as editable TypeScript:

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

Set `humanize: true` to keep the generated automation unchanged while replacing direct
Playwright interactions with curved `ghost-cursor` mouse paths, paced scrolling, variable
typing, and occasional cursor movement during browser waits:

```ts
const mosaik = await createMosaik({ headless: false, humanize: true });
```

For the CLI, pass `--humanize` for one run or save it as the project default:

```sh
mosaik config set humanize true
mosaik run "Search for ceramic mugs" --url https://example.com
```

`--no-humanize` overrides the project default. Humanization runs below composition and
discovery, so it does not add steps or change saved action and automation source. The
[Books to Scrape demo](docs/assets/humanized-books-demo.mp4) saves 100 covers by following
four `Next` links across five catalog pages. It never opens the 100 detail pages, and the red
cursor marker makes the generated movement visible in the recording.

That example assumes you've already generated `searchProducts` for your site.
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
on this instance; they don't rewrite your source files.

Mosaik keeps metadata, browser profiles, and run traces in `.mosaik/`. Files a
automation writes or downloads go into the run's `output/` directory. To see what
it's learned so far:

```sh
mosaik actions list
```

## A bit more about how it works

For a new task, the composition agent inspects the site's saved actions and
works out which ones it can reuse. Discovery fills in the gaps. Mosaik then
validates the TypeScript automation and runs it through Playwright, with limits on
execution time and action calls.

A automation finishing without an error doesn't necessarily mean it did the job.
A separate model step reviews the results against the original request. It can
report missing evidence, and runs using existing actions can make bounded
recovery attempts.

Some clicks do more than move around a page. "Place order" spends money; "Send"
contacts another person. Mosaik calls these `external-side-effect` steps, and
action authors mark them explicitly. Normal execution can run them, but repair
won't automatically retry them or continue through one while validating a fix.
Outcome recovery also won't replay a task that already attempted one. Buying
something twice because a locator changed would be a pretty bad repair.

Reuse is per site. An action learned on one shop doesn't automatically work on
another, and a changed page can still break things. Repair currently handles
eligible locator replacements. There's plenty left to figure out here.

## Login and remote browsers

For a local browser, start with:

```sh
mosaik login https://example.com/login --pause
```

Mosaik supports multi-page username, password, and one-time-code forms. Later
runs reuse the site's browser profile and saved login flow.

One detail to know before using this with an account: the local CLI saves
usernames and passwords as unencrypted JSON inside `.mosaik/browser-profiles/`.
It doesn't save one-time codes. Treat that directory like a password and keep
it out of git and shared folders. Credentials go through a trusted prompt,
not through task inputs. The [authentication reference](docs/reference.md#authentication)
explains the flow and its limits.

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

Contributions are welcome. Try Mosaik on a site you care about and tell us where
it breaks, open an issue with an idea, or send a PR. Bug fixes and clearer docs
help a lot. You don't need to know the whole codebase to get involved.

Join us on [Discord](https://discord.gg/QmspQUZ3Ec) to ask questions, share what
you're building, or talk through a contribution.

If you're working on Mosaik itself, `pnpm run check` checks types,
`pnpm run fmt` formats the code, and `pnpm run lint` runs the linter.
Deterministic tests use fake agents or local tools and don't need model keys.

The [reference](docs/reference.md) has the rest, including architecture details,
file downloads, authentication internals, and the automation API.

# Mosaik

Mosaik learns reusable browser actions for one site, composes them into
validated TypeScript automations, and executes those automations with Playwright. The
runtime is deterministic. Agents are used only to repair eligible locator
failures, discover a missing reusable action, or compose a new automation.

The project is currently greenfield with no users we can change anything and
dont have to worry about backwards compatibilty.

It is open source.

## A small glossary

We need to be on the same page with terminology. When communicating, use this
language:

- **you** means the agent reading this file and changing Mosaik.
- **user** means the person using Mosaik to discover reusable automations.
- **agent** means the browser agent a user runs to compose automations.
- **provider** means the LLM inference provider.

## Rules

Don't run the full test suite (`pnpm test`) unless you're explicitly asked to by
the user it takes a long time to run. Run focused tests instead.

Don't run a `pnpm run build` for verification run `pnpm run check` instead.

Run `pnpm run fmt && pnpm run lint` before you commit changes.

Don't overfit to websites that expose a problem, this is a general tool striving
to work well on any web page, find general solutions.

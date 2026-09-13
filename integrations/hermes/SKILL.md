---
name: mosaik
description: Run reusable browser automations with Mosaik.
version: 0.1.0
author: Paul Scheduikat (luantak), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    editorial_name: Mosaik Browser Automations
    editorial_description: Delegate repeatable browser work to a persistent Mosaik project.
    tags: [Browser, Automation, Playwright, Camoufox]
    related_skills: []
    requires_tools: [terminal]
---

# Mosaik Browser Automations

Use Mosaik for browser work that should become reusable TypeScript or run consistently over many pages. Mosaik owns the browser and its persistent project state; Hermes supplies the task, checks the structured result, and reports the evidence.

## When to Use

- The user wants a repeatable browser workflow rather than a one-off interaction.
- The task processes many records, traverses pagination, downloads files, or should run again later.
- Existing actions or automations in the current project may satisfy the task.

Do not use Mosaik for a single lightweight lookup where Hermes browser tools are enough. Do not mix Hermes browser actions into a Mosaik-owned run.

## Prerequisites

- Run from the user's Mosaik automation project. Always use the same workspace for later runs so learned code, browser state, and evidence remain available.
- The `mosaik` command and Hermes terminal tool must be available.
- The installation command selects Camoufox as the project default and stores profiles under `.mosaik/browser-profiles/`.
- Mosaik needs one configured inference route: OpenRouter, OpenCode Go, or Codex sign-in.

## Procedure

1. In the intended workspace, call `terminal` with `mosaik doctor --json`. Read the complete JSON and resolve required failures before running a task. Do not treat a warning for an unused browser as a blocker.
2. If this is not yet a Mosaik project, call `terminal` with `mosaik init`. Do not overwrite an existing project unless the user explicitly requests it.
3. Keep one browser owner. Mosaik owns the browser for the delegated task; do not open or manipulate the same workflow through `browser_exec`, built-in browser tools, or computer use while Mosaik runs.
4. Shell-quote the task, URL, and every input as separate arguments. Call `terminal` from the same workspace with:

   ```sh
   mosaik run "<task>" --url "<https-url>" --json
   ```

   Add typed inputs with repeatable `--input key=value` or one `--input-json '<object>'`. Do not turn credentials into task inputs.

5. Parse the JSON result. Distinguish automation execution success from task completion, preserve reported uncertainty, and surface any approval requirement instead of retrying.
6. Report the grounded answer and relevant output files. Files created by a run live under `.mosaik/runs/<run-id>/output/`; verify a named file exists before attaching or claiming it.

## Authentication and Side Effects

Do not pass passwords, one-time codes, or API keys in the task, `--input`, logs, or chat. Mosaik login uses a trusted interactive credential path. If authentication is required and no saved profile works, tell the user to run `mosaik login <url> --browser camoufox` in their own interactive terminal, then retry from the same workspace.

Obtain explicit user confirmation before starting a task that may send messages, place orders, delete data, publish content, or otherwise change external state. Never automatically replay a run after an external side effect or an uncertain outcome.

## Persistence and Browser Ownership

Mosaik's Camoufox integration uses `camoufox-js` directly. Its project-local browser profiles are separate from Hermes' Camofox server and `browser.camofox.managed_persistence`; do not claim that cookies, tabs, or profile identities are shared between them.

If the user explicitly selects another Mosaik provider, honor it with `--browser local`, `--browser kernel`, or the corresponding project configuration. Never silently fall back from Camoufox because a missing browser installation is actionable through `mosaik setup --browser camoufox`.

## Verification

- `mosaik doctor --json` reports Camoufox ready and no required failure.
- The command exits successfully and returns valid JSON.
- The result says the requested task is complete, not merely that execution finished.
- Every reported output file exists in the current run directory.
- A repeated task runs from the same workspace and can reuse its saved Mosaik state.

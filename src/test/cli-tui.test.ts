import assert from "node:assert/strict";
import { test } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import { createElement } from "react";
import {
  cycleInputHistory,
  cycleSlashCommand,
  enterBehavior,
  insertAtCursor,
  isMultilineInput,
  moveCursor,
  moveCursorVertically,
  parseInteractiveInput,
  progressLabel,
  removeAtCursor,
  removeBeforeCursor,
  sessionFooter,
  StartView,
  validateWebUrl,
} from "../cli-tui.js";

test("interactive mode starts by asking for a URL", () => {
  const output = stripVTControlCharacters(
    renderToString(
      createElement(StartView, {
        version: "0.1.0",
        workingDirectory: "/tmp/mosaik-test",
        value: "",
      }),
    ),
  );

  assert.match(output, /Where should we start\?/);
  assert.match(output, /Mosaik opens the browser immediately/);
  assert.doesNotMatch(output, /What do you want to do/);
});

test("tool progress says what Mosaik is doing", () => {
  assert.equal(
    progressLabel({ kind: "tool-call", message: "prepareComposition" }),
    "Calling prepareComposition",
  );
  assert.equal(
    progressLabel({ kind: "tool-result", message: "run_code" }),
    "Received run_code output",
  );
});

test("plain Enter sends and Shift+Enter adds a newline", () => {
  assert.equal(enterBehavior(false), "submit");
  assert.equal(enterBehavior(true), "newline");
  assert.equal(isMultilineInput("", { return: true, shift: true }), true);
  assert.equal(isMultilineInput("\\", { return: false, shift: true }), true);
  assert.equal(isMultilineInput("\\", { return: false, shift: false }), false);
});

test("interactive input recognizes tasks and registered commands", () => {
  assert.deepEqual(parseInteractiveInput("Find the cheapest mug\nand open it"), {
    kind: "task",
    task: "Find the cheapest mug\nand open it",
  });
  assert.deepEqual(parseInteractiveInput("/login"), { kind: "login" });
  assert.deepEqual(parseInteractiveInput("login"), { kind: "login" });
  assert.deepEqual(parseInteractiveInput("/new"), { kind: "new" });
  assert.deepEqual(parseInteractiveInput("/login https://example.test"), {
    kind: "error",
    message: "/login does not take arguments",
  });
  assert.deepEqual(parseInteractiveInput("/wat"), {
    kind: "error",
    message: "Unknown command /wat. Type /help for commands.",
  });
});

test("arrow keys cycle slash commands using the original prefix", () => {
  const first = cycleSlashCommand("/", "next");
  assert.equal(first?.value, "/login");
  const second = cycleSlashCommand(first!.value, "next", first!.state);
  assert.equal(second?.value, "/new");
  const wrapped = cycleSlashCommand(second!.value, "previous", second!.state);
  assert.equal(wrapped?.value, "/login");
  assert.equal(cycleSlashCommand("/l", "next")?.value, "/login");
  assert.equal(cycleSlashCommand("plain text", "next"), undefined);
});

test("arrow keys recall history and restore the unfinished draft", () => {
  const history = ["first prompt", "second\nmultiline prompt"];
  const latest = cycleInputHistory(history, "unfinished", "previous");
  assert.equal(latest?.value, "second\nmultiline prompt");
  const older = cycleInputHistory(history, latest!.value, "previous", latest!.state);
  assert.equal(older?.value, "first prompt");
  const newer = cycleInputHistory(history, older!.value, "next", older!.state);
  assert.equal(newer?.value, "second\nmultiline prompt");
  const draft = cycleInputHistory(history, newer!.value, "next", newer!.state);
  assert.equal(draft?.value, "unfinished");
  assert.equal(cycleInputHistory([], "draft", "previous"), undefined);
});

test("input editing inserts, removes, and navigates at the cursor", () => {
  const middle = moveCursor({ value: "books", cursor: 5 }, "left");
  assert.deepEqual(insertAtCursor(middle, "!"), { value: "book!s", cursor: 5 });
  assert.deepEqual(removeBeforeCursor({ value: "book!s", cursor: 5 }), {
    value: "books",
    cursor: 4,
  });
  assert.deepEqual(removeAtCursor({ value: "book!s", cursor: 4 }), {
    value: "books",
    cursor: 4,
  });
  assert.equal(moveCursorVertically("first line\nsecond line", 3, "down"), 14);
  assert.equal(moveCursorVertically("first line\nsecond line", 14, "up"), 3);
});

test("chat footer includes the current run ID", () => {
  assert.match(sessionFooter("run-123", true), /^session run-123 · enter send/);
  assert.match(sessionFooter("run-123", true), /arrows navigate/);
  assert.match(sessionFooter("run-123", true), /↑\/↓ history or \/ commands/);
  assert.match(sessionFooter("run-123", false), /^session run-123 · ctrl\+c cancel/);
});

test("start URL validation explains how to fix invalid input", () => {
  assert.equal(validateWebUrl(undefined), "Enter a start URL");
  assert.equal(
    validateWebUrl("example.test"),
    "Enter a complete URL, for example https://example.com",
  );
  assert.equal(
    validateWebUrl("file:///tmp/page.html"),
    "The URL must start with http:// or https://",
  );
  assert.equal(validateWebUrl("https://example.test"), undefined);
});

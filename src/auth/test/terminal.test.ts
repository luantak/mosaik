import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "vitest";
import { createTerminalCredentialPrompter, maskedInput } from "../terminal.js";
import type { AuthChallenge } from "../types.js";

class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly rawTransitions: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawTransitions.push(mode);
    return this;
  }
}

class TtyOutput extends Writable {
  readonly isTTY = true;
  text = "";

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.text += typeof chunk === "string" ? chunk : chunk.toString();
    callback();
  }
}

test("masked terminal input prints feedback for typing, paste, and backspace", async () => {
  const input = new TtyInput();
  const output = new TtyOutput();
  input.pause();
  const answer = maskedInput(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
  );

  input.write("past");
  input.write("\u007fte\n");

  assert.equal(await answer, "paste");
  assert.equal(output.text, "****\b \b**\n");
  assert.equal(output.text.includes("paste"), false);
  assert.deepEqual(input.rawTransitions, [true, false]);
  assert.equal(input.isPaused(), true);
});

test("terminal prompter masks both passwords and one-time codes", async () => {
  const input = new TtyInput();
  const output = new TtyOutput();
  const challenge: AuthChallenge = {
    url: "http://localhost:3000/login",
    title: "Sign in",
    step: 1,
    fields: [
      {
        id: "password",
        label: "Password",
        kind: "password",
        required: true,
        secret: true,
      },
      {
        id: "otp",
        label: "Security code",
        kind: "one-time-code",
        required: true,
        secret: true,
      },
    ],
  };
  const values = createTerminalCredentialPrompter(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
  ).prompt(challenge);

  input.write("hunter2\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write("246810\n");

  assert.deepEqual(await values, { password: "hunter2", otp: "246810" });
  assert.equal(output.text.includes("hunter2"), false);
  assert.equal(output.text.includes("246810"), false);
  assert.match(output.text, /Password: \*{7}\nSecurity code: \*{6}\n/);
});

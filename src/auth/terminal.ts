import { createInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import type { AuthChallenge, CredentialPrompter } from "./types.js";

export function createTerminalCredentialPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): CredentialPrompter {
  return {
    async prompt(challenge: Readonly<AuthChallenge>) {
      output.write(`Authentication step ${challenge.step} at ${new URL(challenge.url).origin}\n`);
      const values: Record<string, string> = {};
      for (const field of challenge.fields) {
        values[field.id] = field.secret
          ? await hiddenQuestion(`${field.label}: `, input, output)
          : await visibleQuestion(`${field.label}: `, input, output);
      }
      return values;
    },
  };
}

async function visibleQuestion(
  prompt: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<string> {
  const reader = createInterface({ input, output, terminal: output.isTTY });
  try {
    return await reader.question(prompt);
  } finally {
    reader.close();
  }
}

async function hiddenQuestion(
  prompt: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("A TTY is required to enter hidden login values");
  }
  output.write(prompt);
  return maskedInput(input, output);
}

export function maskedInput(input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<string> {
  const wasRaw = input.isRaw ?? false;
  const decoder = new StringDecoder("utf8");
  let value = "";
  let inEscapeSequence = false;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const erase = (): void => {
      const characters = [...value];
      if (characters.length === 0) return;
      characters.pop();
      value = characters.join("");
      output.write("\b \b");
    };
    const clear = (): void => {
      const length = [...value].length;
      value = "";
      output.write("\b \b".repeat(length));
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (const character of text) {
        if (settled) return;
        if (inEscapeSequence) {
          if ((character >= "A" && character <= "Z") || character === "~") {
            inEscapeSequence = false;
          }
          continue;
        }
        if (character === "\u001b") {
          inEscapeSequence = true;
          continue;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(new Error("Authentication input was cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          erase();
          continue;
        }
        if (character === "\u0015") {
          clear();
          continue;
        }
        if (character < " ") continue;
        value += character;
        output.write("*");
      }
    };
    const onEnd = (): void => finish(new Error("Authentication input ended before submission"));
    const onError = (error: Error): void => finish(error);

    input.setRawMode(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
  });
}

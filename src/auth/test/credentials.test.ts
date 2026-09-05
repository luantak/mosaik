import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProfileCredentialPrompter, profileCredentialsPath } from "../credentials.js";
import type { AuthChallenge, CredentialPrompter } from "../types.js";

const challenge: AuthChallenge = {
  url: "http://localhost:3000/login?return=/account",
  title: "Sign in",
  step: 1,
  fields: [
    {
      id: "username-field",
      label: "Email",
      kind: "username",
      required: true,
      secret: false,
      autocomplete: "username",
    },
    {
      id: "password-field",
      label: "Password",
      kind: "password",
      required: true,
      secret: true,
      autocomplete: "current-password",
    },
    {
      id: "otp-field",
      label: "Security code",
      kind: "one-time-code",
      required: true,
      secret: true,
      autocomplete: "one-time-code",
    },
  ],
  submitLabel: "Sign in",
};

test("profile credential prompts reuse raw values, exclude one-time codes, and replace rejected values", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "mosaik-credentials-"));
  const profileDirectory = join(temporaryDirectory, "profile");
  const firstFallback: CredentialPrompter = {
    async prompt(promptedChallenge) {
      assert.deepEqual(
        promptedChallenge.fields.map((field) => field.kind),
        ["username", "password", "one-time-code"],
      );
      return {
        "username-field": "person@example.com",
        "password-field": "first password",
        "otp-field": "123456",
      };
    },
  };

  try {
    const first = createProfileCredentialPrompter(profileDirectory, firstFallback);
    assert.deepEqual(await first.prompt(challenge), {
      "username-field": "person@example.com",
      "password-field": "first password",
      "otp-field": "123456",
    });

    const credentialsPath = profileCredentialsPath(profileDirectory);
    let raw = await readFile(credentialsPath, "utf8");
    assert.equal(raw.includes("person@example.com"), true);
    assert.equal(raw.includes("first password"), true);
    assert.equal(raw.includes("123456"), false);
    if (process.platform !== "win32") {
      assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
    }

    const promptedFieldKinds: string[][] = [];
    let fallbackCalls = 0;
    const laterFallback: CredentialPrompter = {
      async prompt(promptedChallenge) {
        promptedFieldKinds.push(promptedChallenge.fields.map((field) => field.kind));
        fallbackCalls += 1;
        return fallbackCalls === 1
          ? { "otp-field": "654321" }
          : {
              "username-field": "replacement@example.com",
              "password-field": "replacement password",
              "otp-field": "987654",
            };
      },
    };
    const later = createProfileCredentialPrompter(profileDirectory, laterFallback);

    assert.deepEqual(await later.prompt(challenge), {
      "username-field": "person@example.com",
      "password-field": "first password",
      "otp-field": "654321",
    });
    assert.deepEqual(await later.prompt(challenge), {
      "username-field": "replacement@example.com",
      "password-field": "replacement password",
      "otp-field": "987654",
    });
    assert.deepEqual(promptedFieldKinds, [
      ["one-time-code"],
      ["username", "password", "one-time-code"],
    ]);

    raw = await readFile(credentialsPath, "utf8");
    assert.equal(raw.includes("replacement@example.com"), true);
    assert.equal(raw.includes("replacement password"), true);
    assert.equal(raw.includes("person@example.com"), false);
    assert.equal(raw.includes("first password"), false);
    assert.equal(raw.includes("654321"), false);
    assert.equal(raw.includes("987654"), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

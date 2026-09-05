import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authAutomationFilePath, openFileRepository } from "../../persist/index.js";
import { openBrowserSession, startFixtureServer } from "../../runtime/index.js";
import { createProfileCredentialPrompter } from "../credentials.js";
import { loginWithBrowserSession } from "../login.js";
import {
  MULTISTEP_FIXTURE_EMAIL,
  MULTISTEP_FIXTURE_OTP,
  MULTISTEP_FIXTURE_PASSWORD,
  multistepAuthFixtureRoutes,
} from "../multistep-fixture.js";
import type { AuthChallenge, AuthSuccessAgent, CredentialPrompter } from "../types.js";

test("email, password, and OTP login persists and replays a typed authentication automation", async () => {
  const email = MULTISTEP_FIXTURE_EMAIL;
  const password = MULTISTEP_FIXTURE_PASSWORD;
  const otp = MULTISTEP_FIXTURE_OTP;
  const fixture = await startFixtureServer(multistepAuthFixtureRoutes());
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "mosaik-multistep-auth-"));
  const profileDirectory = join(temporaryDirectory, "browser-profile");
  const repository = openFileRepository(join(temporaryDirectory, "repository"));
  let agentCalls = 0;
  const successAgent: AuthSuccessAgent = {
    async inferSuccess(request) {
      agentCalls += 1;
      const marker = request.candidates.find((candidate) =>
        /user menu/i.test(candidate.description),
      );
      assert.notEqual(marker, undefined);
      return {
        authenticated: true,
        markerId: marker!.id,
        reason: "The account user menu is visible",
      };
    },
  };
  const firstChallenges: AuthChallenge[] = [];
  const firstPrompt: CredentialPrompter = {
    async prompt(challenge) {
      firstChallenges.push(structuredClone(challenge));
      const field = challenge.fields[0]!;
      return {
        [field.id]: field.kind === "username" ? email : field.kind === "password" ? password : otp,
      };
    },
  };

  try {
    const firstSession = await openBrowserSession({ profileDirectory });
    let first: Awaited<ReturnType<typeof loginWithBrowserSession>>;
    try {
      first = await loginWithBrowserSession(firstSession, {
        loginUrl: `${fixture.origin}/login`,
        prompter: createProfileCredentialPrompter(profileDirectory, firstPrompt),
        successAgent,
      });
    } finally {
      await firstSession.close();
    }
    await repository.saveAuthAutomation(first.automation);
    assert.deepEqual(await repository.listAuthAutomationIds(), [first.automation.id]);

    assert.equal(first.steps, 3);
    assert.equal(first.successConditionSource, "agent");
    assert.deepEqual(
      firstChallenges.map((challenge) => challenge.fields.map((field) => field.kind)),
      [["username"], ["password"], ["one-time-code"]],
    );
    assert.deepEqual(
      first.automation.steps.map((step) => step.fields.map((field) => field.kind)),
      [["username"], ["password"], ["one-time-code"]],
    );

    const automationPath = authAutomationFilePath(
      join(temporaryDirectory, "repository"),
      first.automation.id,
    );
    const automationSource = await readFile(automationPath, "utf8");
    assert.equal(automationSource.includes('"one-time-code"'), true);
    assert.equal(automationSource.includes(email), false);
    assert.equal(automationSource.includes(password), false);
    assert.equal(automationSource.includes(otp), false);

    const logoutSession = await openBrowserSession({ profileDirectory });
    try {
      await logoutSession.withPage(async (page) => {
        await page.goto(`${fixture.origin}/account`);
        await page.context().clearCookies();
        await page.evaluate(() => localStorage.clear());
      });
    } finally {
      await logoutSession.close();
    }

    const replayChallenges: AuthChallenge[] = [];
    const secondSession = await openBrowserSession({ profileDirectory });
    try {
      const replay = await loginWithBrowserSession(secondSession, {
        loginUrl: `${fixture.origin}/login`,
        prompter: createProfileCredentialPrompter(profileDirectory, {
          async prompt(challenge) {
            replayChallenges.push(structuredClone(challenge));
            assert.deepEqual(
              challenge.fields.map((field) => field.kind),
              ["one-time-code"],
            );
            return { [challenge.fields[0]!.id]: otp };
          },
        }),
        savedAutomation: (await repository.getAuthAutomation(first.automation.id))!,
        successAgent,
      });
      assert.equal(replay.steps, 3);
      assert.equal(replay.successConditionSource, "saved");
      assert.equal(replay.automation.version, first.automation.version);
      assert.equal(agentCalls, 1);
      assert.deepEqual(
        replayChallenges.map((challenge) => challenge.fields.map((field) => field.kind)),
        [["one-time-code"]],
      );
    } finally {
      await secondSession.close();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await fixture.close();
  }
});

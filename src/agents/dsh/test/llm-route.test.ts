import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { test } from "vitest";
import { DISCOVERY_PROFILE } from "../discovery-profile.js";
import {
  DEFAULT_LLM_MODEL,
  defaultLlmReasoning,
  applyLlmRoute,
  availableLlmChoices,
  formatLlmChoicesDetail,
  formatLlmRouteLabel,
  llmChoiceNumber,
  llmModelFlag,
  matchLlmChoices,
  patchDshProfile,
  resolveConfiguredLlmRoute,
  resolveLlmRoute,
  resolvePickedLlmModel,
} from "../llm-route.js";

test("resolveLlmRoute keeps OpenRouter models and maps Codex catalog ids", () => {
  assert.deepEqual(resolveLlmRoute(), {
    provider: "openrouter",
    model: DEFAULT_LLM_MODEL,
  });
  assert.deepEqual(resolveLlmRoute("openai/gpt-5.6-luna:nitro"), {
    provider: "openrouter",
    model: "openai/gpt-5.6-luna:nitro",
  });
  assert.deepEqual(resolveLlmRoute("gpt-5.6-luna"), {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
  });
  assert.deepEqual(resolveLlmRoute("luna"), {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
  });
  assert.deepEqual(resolveLlmRoute("openai-codex/gpt-5.6-luna"), {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
  });
  assert.throws(
    () => resolveLlmRoute("openai-codex/gpt-5.3-codex-spark"),
    /Codex currently allows/,
  );
});

test("configured routes keep an explicit provider and format Codex flags", () => {
  assert.deepEqual(resolveConfiguredLlmRoute({ model: "gpt-5.6-luna" }), {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
  });
  assert.deepEqual(resolveConfiguredLlmRoute({ provider: "openai-codex", model: "gpt-5.6-luna" }), {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
  });
  assert.throws(
    () => resolveConfiguredLlmRoute({ provider: "openai-codex", model: "gpt-5.3-codex-spark" }),
    /Codex currently allows/,
  );
  assert.deepEqual(
    resolveConfiguredLlmRoute({
      provider: "openrouter",
      model: "openai/gpt-5.6-luna:nitro",
    }),
    { provider: "openrouter", model: "openai/gpt-5.6-luna:nitro" },
  );
  assert.equal(
    llmModelFlag({ provider: "openai-codex", model: "gpt-5.6-luna" }),
    "openai-codex/gpt-5.6-luna",
  );
  assert.equal(
    llmModelFlag({ provider: "openrouter", model: "openai/gpt-5.6-luna:nitro" }),
    "openai/gpt-5.6-luna:nitro",
  );
  assert.equal(formatLlmRouteLabel("gpt-5.6-luna"), "openai-codex · gpt-5.6-luna");
  assert.equal(
    formatLlmRouteLabel("openai/gpt-5.6-luna:nitro"),
    "openrouter · openai/gpt-5.6-luna:nitro",
  );
});

test("available models can be listed and picked by number or unique filter", () => {
  const choices = availableLlmChoices();
  assert.equal(choices[0]?.provider, "openrouter");
  assert.equal(choices[1]?.model, "gpt-5.6-luna");
  assert.equal(llmChoiceNumber(choices[1]!), 2);
  assert.equal(resolvePickedLlmModel("2"), "openai-codex/gpt-5.6-luna");
  assert.throws(() => resolvePickedLlmModel("codex"), /more than one model/);
  assert.equal(matchLlmChoices("luna").length, 3);
  assert.throws(() => resolvePickedLlmModel("luna"), /↑\/↓ to pick/);
  assert.match(formatLlmChoicesDetail("gpt-5.6-luna"), /2  openai-codex  gpt-5\.6-luna  current/);
});

test("applyLlmRoute switches the DSH default provider for Codex Luna", () => {
  const profile = applyLlmRoute(DISCOVERY_PROFILE, "gpt-5.6-luna");
  assert.match(profile, /provider: openai-codex/);
  assert.match(profile, /model: gpt-5\.6-luna/);
  assert.match(profile, /openai-codex:[\s\S]*?        reasoning: high/);
  assert.doesNotMatch(profile, /^    provider: openrouter$/m);
  assert.match(profile, /apiKeyEnv: OPENROUTER_API_KEY/);
});

test("patchDshProfile updates reasoning on every provider block", () => {
  const profile = patchDshProfile(DISCOVERY_PROFILE, {
    model: "luna",
    reasoning: "low",
    plugin: "/tmp/plugin.js",
    persona: "      Test persona",
  });
  assert.match(profile, /provider: openai-codex/);
  assert.match(profile, /model: gpt-5\.6-luna/);
  assert.equal(profile.includes("        reasoning: high"), false);
  assert.match(profile, /reasoning: low/);
  assert.match(profile, /"\/tmp\/plugin\.js"/);
  assert.match(profile, /Test persona/);
});

for (const model of ["deepseek-v4.1-flash", "gpt-5.6-luna"]) {
  test(`OpenCode Go ${model} routes and survives model selection`, () => {
    const route = { provider: "opencode-go" as const, model };
    const flag = `opencode-go/${model}`;
    assert.deepEqual(resolveLlmRoute(flag), route);
    assert.deepEqual(resolveConfiguredLlmRoute(route), route);
    assert.equal(llmModelFlag(route), flag);
    assert.equal(resolvePickedLlmModel(flag), flag);
    assert.ok(availableLlmChoices().some((choice) => llmModelFlag(choice) === flag));
  });

  test(`both agent profiles configure the Go transport for ${model}`, async () => {
    const auth = await readFile(new URL("../auth-profile.cordis.yml", import.meta.url), "utf8");
    for (const template of [DISCOVERY_PROFILE, auth]) {
      const profile = patchDshProfile(template, {
        model: `opencode-go/${model}`,
        reasoning: "low",
      });
      const entries = parse(
        profile.replace("!!js process.env.DSH_POC_SESSION_DIR", '"/tmp/session"'),
      );
      const config = entries.find((entry: { id: string }) => entry.id === "llm-pi-ai").config;
      const go = config.providers["opencode-go"];
      assert.equal(go.apiKeyEnv, "OPENCODE_API_KEY");
      assert.equal(go.headers["User-Agent"], "mosaik");
      assert.match(go.headers["x-opencode-session"], /^[0-9a-f-]{36}$/);
      assert.equal(go.baseURL, "https://opencode.ai/zen/go/v1");
      assert.equal(
        go.api,
        model === "deepseek-v4.1-flash" ? "openai-completions" : "openai-responses",
      );
      assert.equal(go.reasoning, "low");
      assert.deepEqual(
        go.models.map((entry: { id: string }) => entry.id),
        [model],
      );
      assert.ok(
        config.providers.openrouter.models.some(
          (entry: { id: string }) => entry.id === "deepseek/deepseek-v4.1-flash:nitro",
        ),
      );
      assert.deepEqual(
        entries.find((entry: { id: string }) => entry.id === "agent-default-model").config,
        { provider: "opencode-go", model },
      );
    }
  });
}

test("OpenCode Go aliases stay on Go and unsupported models fail early", () => {
  assert.deepEqual(resolveLlmRoute("opencode-go/luna"), {
    provider: "opencode-go",
    model: "gpt-5.6-luna",
  });
  assert.throws(() => resolveLlmRoute("opencode-go/missing"), /OpenCode Go currently allows/);
  assert.equal(
    resolvePickedLlmModel("deepseek/deepseek-v4.1-flash:nitro"),
    "deepseek/deepseek-v4.1-flash:nitro",
  );
});

test("Terra uses medium composition and low discovery defaults", () => {
  const terra = "openai-codex/gpt-5.6-terra";
  assert.equal(defaultLlmReasoning(terra, "composition"), "medium");
  assert.equal(defaultLlmReasoning(terra, "discovery"), "low");
  for (const model of [
    DEFAULT_LLM_MODEL,
    "opencode-go/gpt-5.6-luna",
    "opencode-go/deepseek-v4.1-flash",
  ]) {
    assert.equal(defaultLlmReasoning(model, "composition"), "high");
    assert.equal(defaultLlmReasoning(model, "discovery"), "high");
  }
});

test("Codex Terra is selectable by alias and full id", () => {
  const route = { provider: "openai-codex", model: "gpt-5.6-terra" };
  for (const model of ["terra", "gpt-5.6-terra", "openai-codex/gpt-5.6-terra"]) {
    assert.deepEqual(resolveLlmRoute(model), route);
    assert.equal(resolvePickedLlmModel(model), "openai-codex/gpt-5.6-terra");
  }
  assert.deepEqual(resolveConfiguredLlmRoute(route), route);
  assert.ok(availableLlmChoices().some((choice) => choice.model === route.model));
  assert.ok(availableLlmChoices().every((choice) => !choice.model.includes("muse")));
});

test("both Terra profiles cap higher reasoning and preserve low", async () => {
  const auth = await readFile(new URL("../auth-profile.cordis.yml", import.meta.url), "utf8");
  for (const template of [DISCOVERY_PROFILE, auth]) {
    for (const reasoning of ["low", "medium", "high", "xhigh", "max"]) {
      const profile = patchDshProfile(template, { model: "terra", reasoning });
      const entries = parse(
        profile.replace("!!js process.env.DSH_POC_SESSION_DIR", '"/tmp/session"'),
      );
      const codex = entries.find((entry: { id: string }) => entry.id === "llm-pi-ai").config
        .providers["openai-codex"];
      assert.equal(codex.reasoning, reasoning === "low" ? "low" : "medium");
      assert.deepEqual(codex.modelOverrides["gpt-5.6-terra"].reasoningEfforts, {
        low: "low",
        medium: "medium",
      });
    }
  }
});

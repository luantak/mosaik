import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AuthSuccessAgent,
  AuthSuccessAgentDecision,
  AuthSuccessAgentRequest,
} from "../../auth/index.js";
import {
  dshFailureReason,
  extractJsonObjects,
  loadProjectEnv,
  runDshChild,
  type DshReasoning,
} from "./session.js";
import { dshResourcePath, resolveDshCommand } from "./paths.js";

export class DshAuthSuccessAgent implements AuthSuccessAgent {
  constructor(
    readonly projectRoot = process.cwd(),
    readonly options: { model?: string; reasoning?: DshReasoning; runRoot?: string } = {},
  ) {}

  async inferSuccess(request: AuthSuccessAgentRequest): Promise<AuthSuccessAgentDecision> {
    await loadProjectEnv(this.projectRoot);
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY is required for authentication success inference");
    }
    const model =
      this.options.model ?? process.env.MOSAIK_AUTH_MODEL ?? "openai/gpt-5.6-luna:nitro";
    const reasoning = this.options.reasoning ?? "low";
    const runDirectory = resolve(
      this.options.runRoot ?? resolve(this.projectRoot, ".dsh-poc-runs"),
      randomUUID(),
    );
    await mkdir(runDirectory, { recursive: true });
    const template = await readFile(dshResourcePath("auth-profile.cordis.yml"), "utf8");
    const profile = template
      .replace(/model: openai\/gpt-5\.6-luna:nitro/g, `model: ${model}`)
      .replace("        reasoning: low", `        reasoning: ${reasoning}`);
    const profilePath = resolve(runDirectory, "auth-profile.cordis.yml");
    await writeFile(profilePath, profile, "utf8");
    const dsh = resolveDshCommand();
    const child = await runDshChild(
      dsh.executable,
      [
        ...dsh.prefixArgs,
        "--profile",
        "headless",
        "--patch",
        profilePath,
        `Decide whether login succeeded and select a replayable marker when possible.\n${JSON.stringify(request)}`,
      ],
      {
        ...process.env,
        DSH_POC_SESSION_DIR: runDirectory,
        DSH_TELEMETRY_DISABLED: "1",
      },
    );
    const candidates = extractJsonObjects(child.stdout);
    const decision = candidates
      .map((value) => parseAuthSuccessAgentDecision(value, request))
      .findLast((value) => value !== undefined);
    if (decision !== undefined) return decision;
    throw new Error(
      dshFailureReason(child, candidates, "The authentication agent returned no valid decision"),
    );
  }
}

export function parseAuthSuccessAgentDecision(
  value: unknown,
  request: Pick<AuthSuccessAgentRequest, "candidates">,
): AuthSuccessAgentDecision | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.authenticated !== "boolean") return undefined;
  if (typeof candidate.reason !== "string" || candidate.reason.trim().length === 0) {
    return undefined;
  }
  if (candidate.markerId !== undefined) {
    if (typeof candidate.markerId !== "string") return undefined;
    if (!candidate.authenticated) return undefined;
    if (!request.candidates.some((marker) => marker.id === candidate.markerId)) return undefined;
  }
  return {
    authenticated: candidate.authenticated,
    reason: candidate.reason.trim(),
    ...(typeof candidate.markerId === "string" ? { markerId: candidate.markerId } : {}),
  };
}

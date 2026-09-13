import { saveDefaultBrowser } from "../config.js";

export function hermesSkillUrl(packageVersion: string): string {
  return `https://cdn.jsdelivr.net/npm/mosaik@${encodeURIComponent(packageVersion)}/integrations/hermes/SKILL.md`;
}

export function hermesSkillInstallArgs(packageVersion: string): readonly string[] {
  return ["skills", "install", hermesSkillUrl(packageVersion), "--force", "--yes", "--now"];
}

export function hermesSkillSnapshotMatches(snapshot: unknown, expectedIdentifier: string): boolean {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const skills = (snapshot as Record<string, unknown>).skills;
  if (!Array.isArray(skills)) return false;
  return skills.some(
    (skill) =>
      skill !== null &&
      typeof skill === "object" &&
      !Array.isArray(skill) &&
      (skill as Record<string, unknown>).name === "mosaik" &&
      (skill as Record<string, unknown>).identifier === expectedIdentifier,
  );
}

export interface HermesIntegrationOptions {
  dataDirectory: string;
  packageVersion: string;
}

export interface HermesIntegrationActions {
  installSkill(args: readonly string[]): Promise<number>;
  verifySkill(expectedIdentifier: string): Promise<boolean>;
  installCamoufox(): Promise<number>;
}

export interface HermesIntegrationResult {
  skillInstalled: boolean;
  camoufoxInstalled: boolean;
}

export async function installHermesIntegration(
  options: HermesIntegrationOptions,
  actions: HermesIntegrationActions,
): Promise<HermesIntegrationResult> {
  const skillExit = await actions.installSkill(hermesSkillInstallArgs(options.packageVersion));
  if (skillExit !== 0) return { skillInstalled: false, camoufoxInstalled: false };
  const skillInstalled = await actions.verifySkill(hermesSkillUrl(options.packageVersion));
  if (!skillInstalled) return { skillInstalled: false, camoufoxInstalled: false };
  const camoufoxExit = await actions.installCamoufox();
  if (camoufoxExit !== 0) return { skillInstalled: true, camoufoxInstalled: false };
  await saveDefaultBrowser(options.dataDirectory, "camoufox");
  return { skillInstalled: true, camoufoxInstalled: true };
}

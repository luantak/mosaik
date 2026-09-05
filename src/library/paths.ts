import { join } from "node:path";
import { normalizeSiteId } from "../capabilities/site.js";

export function encodeLibraryId(id: string): string {
  return encodeURIComponent(id);
}

export function decodeLibraryId(value: string): string {
  return decodeURIComponent(value.replace(/\.(ts|json)$/, ""));
}

export function actionSourcePath(libraryRoot: string, siteId: string, actionName: string): string {
  return join(
    libraryRoot,
    "sites",
    encodeLibraryId(normalizeSiteId(siteId)),
    "actions",
    `${actionName}.ts`,
  );
}

export function actionMetaPath(dataRoot: string, siteId: string, actionId: string): string {
  return join(
    dataRoot,
    "sites",
    encodeLibraryId(normalizeSiteId(siteId)),
    "actions",
    `${encodeLibraryId(actionId)}.json`,
  );
}

export function actionSourceDirectory(libraryRoot: string, siteId: string): string {
  return join(libraryRoot, "sites", encodeLibraryId(normalizeSiteId(siteId)), "actions");
}

export function actionMetaDirectory(dataRoot: string, siteId: string): string {
  return join(dataRoot, "sites", encodeLibraryId(normalizeSiteId(siteId)), "actions");
}

export function automationSourceDirectory(libraryRoot: string, siteId: string): string {
  return join(libraryRoot, "sites", encodeLibraryId(normalizeSiteId(siteId)), "automations");
}

export function automationMetaDirectory(dataRoot: string, siteId: string): string {
  return join(dataRoot, "sites", encodeLibraryId(normalizeSiteId(siteId)), "automations");
}

export function automationSourcePath(
  libraryRoot: string,
  siteId: string,
  automationId: string,
): string {
  return join(automationSourceDirectory(libraryRoot, siteId), `${automationId}.ts`);
}

export function automationMetaPath(dataRoot: string, siteId: string, automationId: string): string {
  return join(
    automationMetaDirectory(dataRoot, siteId),
    encodeLibraryId(automationId),
    "current.json",
  );
}

export function automationImportPath(_siteId: string, actionName: string): string {
  return `../actions/${actionName}.js`;
}

export function relativeAutomationImportPath(automationId: string): string {
  return `./${automationId}.js`;
}

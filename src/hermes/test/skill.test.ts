import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { parse } from "yaml";

const skillUrl = new URL("../../../integrations/hermes/SKILL.md", import.meta.url);

test("the packaged Hermes skill has valid Mosaik metadata", async () => {
  const source = await readFile(skillUrl, "utf8");
  assert.ok(source.startsWith("---\n"));
  const end = source.indexOf("\n---\n", 4);
  assert.ok(end > 0);
  const metadata = parse(source.slice(4, end)) as {
    name?: string;
    description?: string;
    metadata?: { hermes?: { requires_tools?: string[] } };
  };
  assert.equal(metadata.name, "mosaik");
  assert.ok(metadata.description && metadata.description.length <= 60);
  assert.deepEqual(metadata.metadata?.hermes?.requires_tools, ["terminal"]);
  assert.ok(source.slice(end + 5).trim().length > 0);
});

test("the Hermes skill delegates one browser owner and preserves the Mosaik workspace", async () => {
  const source = await readFile(skillUrl, "utf8");
  assert.match(source, /mosaik doctor --json/);
  assert.match(source, /mosaik run[\s\S]*--json/);
  assert.match(source, /same workspace/);
  assert.match(source, /Mosaik owns the browser/);
  assert.match(source, /\.mosaik\/browser-profiles/);
  assert.match(source, /Do not pass passwords, one-time codes, or API keys/);
});

test("the npm package includes the Hermes skill", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { files?: string[] };
  assert.ok(packageJson.files?.includes("integrations/hermes/SKILL.md"));
});

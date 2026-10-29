#!/usr/bin/env node

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  createCatalogueControls,
  seedCatalogueAutomation,
  startCatalogueFixture,
} from "./catalogue.js";

const parsed = parseArgs({
  options: {
    port: { type: "string", default: "4318" },
    project: { type: "string", default: ".mosaik-catalogue" },
    layout: { type: "string", default: "old" },
    unavailable: { type: "string", multiple: true },
    malformed: { type: "string", multiple: true },
    transient: { type: "string", multiple: true },
    "delay-ms": { type: "string", default: "0" },
    "no-seed": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (parsed.values.help) {
  process.stdout
    .write(`Local catalogue fixture: 1,200 independent records with filters and overlapping pages.

Usage: mosaik-fixture [options] (contributors: pnpm run demo:fixture -- [options])
  --port <number>          Fixed port for repeatable resume, default 4318
  --project <directory>    Hand-authored saved-library destination, default .mosaik-catalogue
  --no-seed               Serve only; use for agent discovery or preserve an existing repair
  --layout <old|new>       Record layout, default old
  --unavailable <id>       Always return HTTP 503 for this record (repeatable)
  --transient <id>:<count> Return HTTP 503 count times (repeatable)
  --malformed <id>         Return an empty required title (repeatable)
  --delay-ms <number>      Delay each response, useful for interrupting a run
`);
} else {
  const port = integer(parsed.values.port, "port", 1, 65_535);
  const controls = createCatalogueControls();
  if (parsed.values.layout !== "old" && parsed.values.layout !== "new")
    throw new Error("layout must be old or new");
  controls.layout = parsed.values.layout;
  controls.delayMs = integer(parsed.values["delay-ms"], "delay-ms", 0, 60_000);
  for (const id of parsed.values.unavailable ?? []) controls.unavailableIds.add(id);
  for (const id of parsed.values.malformed ?? []) controls.malformedIds.add(id);
  for (const value of parsed.values.transient ?? []) {
    const [id, count, extra] = value.split(":");
    if (!id || !count || extra !== undefined)
      throw new Error("transient must be <record-id>:<count>");
    controls.transientFailures.set(id, integer(count, "transient count", 1, 100));
  }
  const fixture = await startCatalogueFixture({ port, controls });
  try {
    const project = resolve(parsed.values.project);
    process.stdout.write(`Catalogue: ${fixture.url}\n`);
    if (!parsed.values["no-seed"]) {
      const seeded = await seedCatalogueAutomation(project, fixture.origin);
      process.stdout.write(
        `${seeded.created ? "Created hand-authored fixture seed (not agent discovery)" : "Preserved existing saved automation and repairs"}: ${seeded.sourcePath}\n`,
      );
      process.stdout.write(`Site: ${seeded.siteId}\n`);
      process.stdout.write(`Try from ${project}:\n`);
      process.stdout.write(`  mosaik automations inspect catalogue --site ${seeded.siteId}\n`);
      process.stdout.write(
        `  mosaik execute catalogue --site ${seeded.siteId} --input category=books --input requestedCount=100 --browser local --timeout 180000 --max-action-calls 1000\n`,
      );
      process.stdout.write(
        `  mosaik execute catalogue --site ${seeded.siteId} --input category=games --input requestedCount=100 --browser local --timeout 180000 --max-action-calls 1000\n`,
      );
    }
    process.stdout.write(
      "Press Ctrl-C to stop the fixture. Keep the same port when restarting it.\n",
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void fixture.close().finally(() => process.exit(0));
      });
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return number;
}

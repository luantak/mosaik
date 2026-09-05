import { startFixtureServer } from "../runtime/index.js";
import {
  MULTISTEP_FIXTURE_EMAIL,
  MULTISTEP_FIXTURE_OTP,
  MULTISTEP_FIXTURE_PASSWORD,
  multistepAuthFixtureRoutes,
} from "./multistep-fixture.js";

const port = parsePort(process.env.MOSAIK_AUTH_FIXTURE_PORT ?? "4317");
const fixture = await startFixtureServer(multistepAuthFixtureRoutes(), { port });

process.stdout.write(`Three-step login fixture running at ${fixture.origin}/login\n`);
process.stdout.write(`Email: ${MULTISTEP_FIXTURE_EMAIL}\n`);
process.stdout.write(`Password: ${MULTISTEP_FIXTURE_PASSWORD}\n`);
process.stdout.write(`OTP: ${MULTISTEP_FIXTURE_OTP}\n`);
process.stdout.write("Press Ctrl-C to stop the server.\n");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void fixture.close().finally(() => process.exit(0));
  });
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("MOSAIK_AUTH_FIXTURE_PORT must be an integer from 1 to 65535");
  }
  return parsed;
}

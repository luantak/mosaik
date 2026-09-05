import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createTheme,
  formatExecutionValue,
  formatDuration,
  renderCliError,
  renderDoctorReport,
  renderRootHelp,
  type DoctorReport,
} from "../cli-ui.js";

const plain = createTheme(false);

test("root help gives a quick start without terminal escape codes", () => {
  const output = renderRootHelp("0.1.0", plain);
  assert.match(output, /^Mosaik 0\.1\.0/);
  assert.match(output, /mosaik init/);
  assert.match(output, /mosaik doctor/);
  assert.match(output, /pull\s+Pull learning from the remote library/);
  assert.match(output, /reset\s+Delete learned actions and automations/);
  assert.match(output, /Search for ceramic mugs/);
  assert.equal(output.includes("\u001b["), false);
});

test("doctor report aligns checks and gives fixes for actionable failures", () => {
  const report: DoctorReport = {
    version: "0.1.0",
    workingDirectory: "/project",
    dataDirectory: "/project/.mosaik",
    checks: [
      { id: "node", label: "Node.js", status: "pass", detail: "v22.18.0" },
      {
        id: "chromium",
        label: "Chromium",
        status: "fail",
        detail: "browser binary not found",
        fix: "Run `mosaik setup` to install Chromium.",
      },
    ],
  };
  const output = renderDoctorReport(report, plain);
  assert.match(output, /✓  Node\.js\s+v22\.18\.0/);
  assert.match(output, /×  Chromium\s+browser binary not found/);
  assert.match(output, /1 required check failed/);
  assert.match(output, /1\. Run `mosaik setup`/);
});

test("doctor report has a concise healthy summary", () => {
  const output = renderDoctorReport(
    {
      version: "0.1.0",
      workingDirectory: "/project",
      dataDirectory: "/project/.mosaik",
      checks: [{ id: "node", label: "Node.js", status: "pass", detail: "v22.18.0" }],
    },
    plain,
  );
  assert.match(output, /Everything looks good\. Mosaik is ready\./);
  assert.doesNotMatch(output, /Next steps/);
});

test("CLI errors include command-specific help and durations stay compact", () => {
  assert.equal(
    renderCliError("--url is required", "run", plain),
    "× --url is required\n  Run mosaik run --help for usage.\n",
  );
  assert.equal(formatDuration(412), "412ms");
  assert.equal(formatDuration(1_250), "1.3s");
  assert.equal(formatDuration(14_800), "15s");
});

test("execution values render for ordinary objects and keep collection summaries compact", () => {
  assert.equal(formatExecutionValue({ heading: "Example Domain" }), '{"heading":"Example Domain"}');
  assert.equal(
    formatExecutionValue({ requestedCount: 10, collectedCount: 7, exhausted: true }),
    "7 of 10 collected (site exhausted)",
  );
  assert.equal(formatExecutionValue("Example Domain"), "Example Domain");
  assert.equal(formatExecutionValue(undefined), undefined);
});

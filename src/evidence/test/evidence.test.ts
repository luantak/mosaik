import { emitActionSource, parseActionSource } from "../../library/action-source.js";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { defineAction } from "../../capabilities/define.js";
import { addStateImplementation } from "../../capabilities/implementations.js";
import { applyActionPatches } from "../../capabilities/repair.js";
import { createPlaywrightHost } from "../../automations/host.js";
import { contractFingerprint } from "../capture.js";
import { createCaseStore, retainCases } from "../store.js";
import { checkHistoricalCases } from "../offline.js";
import type { ActionCase } from "../types.js";

const action = () =>
  defineAction({
    id: "page.read",
    siteId: "example.com",
    name: "getPrice",
    description: "Read the current price",
    safety: "read-only",
    outputs: { price: { type: "number", format: "decimal-comma" } },
    steps: [
      {
        id: "price",
        type: "extract-text",
        safety: "read-only",
        locator: { strategy: "css", selector: ".price" },
        output: "price",
      },
    ],
  });
const fixtureCase = (): ActionCase => {
  const dom = {
    html: '<span class="price">19,99</span>',
    complete: true,
    redacted: false,
    unsupported: [],
  };
  return {
    schemaVersion: 1,
    id: "fixture",
    siteId: "example.com",
    actionId: "page.read",
    implementationId: "default",
    contractVersion: 1,
    contractFingerprint: contractFingerprint(action()),
    implementationVersion: 1,
    runId: "fixture",
    capturedAt: Date.now(),
    context: { tab: "fixture", frame: "main" },
    inputs: {},
    inputsComplete: true,
    before: dom,
    after: dom,
    observations: { precondition: null, completion: null },
    steps: [{ stepId: "price", dom, matches: 1, tags: ["span"] }],
    output: { price: 19.99 },
    expectations: [{ stepId: "price", value: 19.99, provenance: "independently-asserted" }],
    fingerprint: "fixture",
  };
};

test("successful cases redact secrets before persistence, round trip, and bound retention", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosaik-cases-"));
  const browser = await chromium.launch({ headless: true });
  try {
    const path = join(root, "cases.json");
    const cases = createCaseStore(path);
    const page = await browser.newPage();
    await page.setContent(
      '<span class="price">19,99</span><input type="password" value="SECRET"><div data-token="SECRET">SECRET</div><script>window.secret="SECRET"</script>',
    );
    const host = createPlaywrightHost(page, [action()], { cases });
    assert.deepEqual(await host.invoke("getPrice", {}), { price: 19.99 });
    const bytes = await readFile(path, "utf8");
    assert.ok(!bytes.includes("SECRET"));
    assert.ok(!bytes.includes("19,99"));
    const stored = await createCaseStore(path).list("page.read");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.steps[0]!.raw, "[redacted]");
    const now = Date.now();
    const fixtures = [0, 1, 2, 3].map((index) => ({
      ...fixtureCase(),
      id: String(index),
      fingerprint: String(index),
      capturedAt: now - index * 1000,
    }));
    assert.equal(
      retainCases(fixtures, { perAction: 2, totalBytes: 100_000, maxAgeMs: 10_000 }, now).length,
      2,
    );
    assert.equal(
      retainCases(fixtures, { perAction: 10, totalBytes: 1, maxAgeMs: 10_000 }, now).length,
      0,
    );
    assert.equal(
      retainCases(fixtures, { perAction: 10, totalBytes: 100_000, maxAgeMs: 500 }, now).length,
      1,
    );
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("offline regression checks reject broken targets and distinguish asserted parsing from observed output", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const record = fixtureCase();
    const good = await checkHistoricalCases(browser, action(), [record]);
    assert.ok(good.some((check) => check.check === "price:parsing" && check.status === "pass"));
    const bad = applyActionPatches(action(), [
      {
        type: "replace-locator",
        stepId: "price",
        locator: { strategy: "css", selector: ".missing" },
      },
    ]);
    assert.ok(
      (await checkHistoricalCases(browser, bad, [record])).some((check) => check.status === "fail"),
    );
    record.expectations[0]!.provenance = "observed";
    assert.ok(
      (await checkHistoricalCases(browser, action(), [record])).some(
        (check) => check.check === "price:parsing" && check.status === "inconclusive",
      ),
    );
    record.steps[0]!.dom = { ...record.before, complete: false };
    assert.ok(
      !(await checkHistoricalCases(browser, action(), [record])).some(
        (check) => check.status === "pass",
      ),
    );
  } finally {
    await browser.close();
  }
});

test("historical DOM executes no scripts or network requests", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("unexpected");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const record = fixtureCase();
    record.steps[0]!.dom.html += `<script>document.querySelector(".price").remove();fetch("${url}/leak")</script><img src="${url}/image"><iframe src="${url}/frame"></iframe>`;
    const checks = await checkHistoricalCases(browser, action(), [record]);
    assert.ok(checks.some((check) => check.check === "price:parsing" && check.status === "pass"));
    assert.equal(requests, 0);
    assert.equal(browser.contexts().length, 0);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("explicit disjoint implementations preserve old state and source contracts", async () => {
  const original = defineAction({
    id: "editor.save",
    siteId: "example.com",
    name: "saveEditor",
    description: "Save the editor",
    safety: "browser-local",
    precondition: {
      kind: "attribute",
      locator: { strategy: "css", selector: "body" },
      name: "data-layout",
      value: "old",
    },
    completion: { kind: "count", locator: { strategy: "css", selector: "button" }, count: 1 },
    steps: [
      {
        id: "save",
        type: "click",
        safety: "browser-local",
        locator: { strategy: "css", selector: ".old" },
      },
    ],
  });
  const newImplementation = {
    ...original.implementation,
    id: "new",
    precondition: {
      kind: "attribute" as const,
      locator: { strategy: "css" as const, selector: "body" },
      name: "data-layout",
      value: "new",
    },
    steps: [
      {
        ...original.implementation.steps[0]!,
        locator: { strategy: "css" as const, selector: ".new" },
      },
    ],
  };
  const next = addStateImplementation(original, {
    type: "add-implementation",
    implementation: newImplementation,
  });
  assert.equal(next.implementations?.length, 2);
  assert.deepEqual(parseActionSource(emitActionSource(next)).implementations, next.implementations);
  assert.equal(contractFingerprint(original), contractFingerprint(next, next.implementations![0]!));
  assert.throws(
    () =>
      addStateImplementation(original, {
        type: "add-implementation",
        implementation: {
          ...newImplementation,
          precondition: original.implementation.precondition!,
        },
      }),
    /disjoint/,
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const host = createPlaywrightHost(page, [next]);
    for (const layout of ["old", "new"]) {
      await page.setContent(
        `<body data-layout="${layout}"><button class="${layout}">Save</button></body>`,
      );
      await host.invoke("saveEditor", {});
    }
  } finally {
    await browser.close();
  }
});

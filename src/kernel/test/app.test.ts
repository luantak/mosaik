import assert from "node:assert/strict";
import test from "node:test";
import Kernel, { appRegistry } from "@onkernel/sdk";
import { resolveKernelLibraryUrl, runKernelMosaik } from "../app.js";
import { registerKernelMosaikApp } from "../index.js";

test("Kernel library configuration accepts Railway Redis without translation", () => {
  assert.equal(resolveKernelLibraryUrl({ REDIS_URL: "redis://railway" }), "redis://railway");
  assert.equal(
    resolveKernelLibraryUrl({
      REDIS_URL: "redis://railway",
      MOSAIK_LIBRARY_URL: "redis://explicit",
    }),
    "redis://explicit",
  );
  assert.equal(resolveKernelLibraryUrl({}), undefined);
});

test("Kernel app registers the hosted login actions", () => {
  registerKernelMosaikApp({ client: new Kernel({ apiKey: "test" }) });
  const app = appRegistry.getApps().at(-1);
  assert.deepEqual(app?.toJSON().actions, [
    { name: "login" },
    { name: "login-status" },
    { name: "run" },
  ]);
});

test("Kernel action rejects invalid payloads before opening a browser", async () => {
  const context = { invocation_id: "test-invocation" };
  await assert.rejects(() => runKernelMosaik(context), /Payload must be an object/);
  await assert.rejects(
    () => runKernelMosaik(context, { task: "", url: "https://example.test" }),
    /task is required/,
  );
  await assert.rejects(
    () => runKernelMosaik(context, { task: "Inspect", url: "file:///tmp/page" }),
    /http or https/,
  );
  await assert.rejects(
    () => runKernelMosaik(context, { task: "Inspect", url: "https://example.test", inputs: [] }),
    /inputs must be an object/,
  );
  await assert.rejects(
    () =>
      runKernelMosaik(context, {
        task: "Inspect",
        url: "https://example.test",
        authConnectionId: "connection",
        profileName: "profile",
      }),
    /Pass either authConnectionId or profileName, not both/,
  );
});

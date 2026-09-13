import assert from "node:assert/strict";
import { test, vi } from "vitest";
import Kernel from "@onkernel/sdk";
import { chromium, type Browser } from "playwright";
import { openKernelBrowserSession } from "../browser-session.js";

test("Kernel sessions select the configured proxy and release the browser", async () => {
  const client = new Kernel({ apiKey: "test" });
  const create = vi
    .spyOn(client.browsers, "create")
    .mockResolvedValue({ session_id: "session", cdp_ws_url: "ws://kernel.test/cdp" } as Awaited<
      ReturnType<typeof client.browsers.create>
    >);
  const remove = vi.spyOn(client.browsers, "deleteByID").mockResolvedValue(undefined);
  const close = vi.fn(async () => {});
  const connect = vi
    .spyOn(chromium, "connectOverCDP")
    .mockResolvedValue({ close } as unknown as Browser);
  try {
    const session = await openKernelBrowserSession({ client, proxyId: "proxy-id" });
    assert.deepEqual(create.mock.calls[0]?.[0]?.proxy, { id: "proxy-id" });
    await session.close();
    assert.equal(close.mock.calls.length, 1);
    assert.deepEqual(remove.mock.calls[0], ["session"]);
  } finally {
    create.mockRestore();
    remove.mockRestore();
    connect.mockRestore();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  getKernelHostedLoginStatus,
  requireAuthenticatedKernelProfile,
  startKernelHostedLogin,
  type KernelAuthConnectionClient,
} from "../hosted-login.js";

function fakeClient(
  connections: Record<string, Record<string, unknown>> = {},
): KernelAuthConnectionClient & {
  created?: Record<string, unknown>;
  loginCalls: string[];
} {
  const client = {
    loginCalls: [],
    auth: {
      connections: {
        list: async (query?: { domain?: string; profile_name?: string }) =>
          Object.values(connections).filter(
            (connection) =>
              (query?.domain === undefined || connection.domain === query.domain) &&
              (query?.profile_name === undefined || connection.profile_name === query.profile_name),
          ),
        retrieve: async (id: string) => connections[id],
        create: async (body: Record<string, unknown>) => {
          const connection = {
            id: "conn_created",
            domain: body.domain,
            profile_name: body.profile_name,
            status: "NEEDS_AUTH",
          };
          connections["conn_created"] = connection;
          client.created = body;
          return connection;
        },
        login: async (id: string) => {
          client.loginCalls.push(id);
          return {
            id,
            hosted_url: "https://auth.example.test/handoff",
            flow_expires_at: new Date(Date.now() + 60_000).toISOString(),
          };
        },
      },
    },
  } as unknown as KernelAuthConnectionClient & {
    created?: Record<string, unknown>;
    loginCalls: string[];
  };
  return client;
}

test("starts a hosted login and omits optional connection fields", async () => {
  const client = fakeClient();
  const result = await startKernelHostedLogin(client, { domain: "Example.com" });
  assert.equal(result.status, "login-required");
  assert.match(result.profileName, /^mosaik-[0-9a-f-]{36}$/);
  assert.deepEqual(client.created, {
    domain: "example.com",
    profile_name: result.profileName,
    health_checks: true,
    auto_reauth: true,
    save_credentials: true,
    browser: { stealth: true },
  });
  assert.deepEqual(client.loginCalls, ["conn_created"]);
});

test("reuses authenticated and active hosted connections", async () => {
  const active = {
    id: "active",
    domain: "example.com",
    profile_name: "saved",
    status: "NEEDS_AUTH",
    flow_status: "IN_PROGRESS",
    flow_expires_at: new Date(Date.now() + 60_000).toISOString(),
    hosted_url: "https://auth.example.test/active",
  };
  const client = fakeClient({ active });
  const activeResult = await startKernelHostedLogin(client, {
    domain: "example.com",
    profileName: "saved",
  });
  assert.equal(activeResult.status, "login-required");
  assert.equal(activeResult.hostedUrl, active.hosted_url);
  assert.deepEqual(client.loginCalls, []);

  const authenticated = {
    ...active,
    id: "authenticated",
    status: "AUTHENTICATED",
    flow_status: null,
  };
  const authenticatedClient = fakeClient({ authenticated });
  const result = await startKernelHostedLogin(authenticatedClient, {
    domain: "example.com",
    profileName: "saved",
  });
  assert.deepEqual(result, {
    status: "authenticated",
    connectionId: "authenticated",
    profileName: "saved",
  });
});

test("maps terminal flow states and bounds failure messages", async () => {
  for (const [flowStatus, status] of [
    ["FAILED", "failed"],
    ["EXPIRED", "expired"],
    ["CANCELED", "canceled"],
  ] as const) {
    const client = fakeClient({
      connection: {
        id: "connection",
        domain: "example.com",
        profile_name: "saved",
        status: "NEEDS_AUTH",
        flow_status: flowStatus,
        error_message: "x".repeat(1000),
      },
    });
    const result = await getKernelHostedLoginStatus(client, "connection");
    assert.equal(result.status, status);
    if (result.status === "failed") assert.equal(result.message?.length, 500);
  }
});

test("requires an authenticated profile on the configured domain", async () => {
  const client = fakeClient({
    connection: {
      id: "connection",
      domain: "example.com",
      profile_name: "saved",
      status: "AUTHENTICATED",
    },
  });
  assert.equal(
    await requireAuthenticatedKernelProfile(client, "connection", "https://app.example.com/task"),
    "saved",
  );
  await assert.rejects(
    () => requireAuthenticatedKernelProfile(client, "connection", "https://badexample.com"),
    /does not permit badexample.com/,
  );
  await assert.rejects(
    () => requireAuthenticatedKernelProfile(client, "connection", "file:///tmp/task"),
    /http or https/,
  );
});

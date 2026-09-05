import assert from "node:assert/strict";
import test from "node:test";
import { formatRepairFlightKey, RepairFlightCoordinator } from "../repair-flight.js";

test("single-flight repair gives one owner and shares the outcome", async () => {
  const flights = new RepairFlightCoordinator();
  let owners = 0;
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      flights.run(
        { siteId: "shop.example.com", actionId: "shop.search-products", baseVersion: 1 },
        async () => {
          owners += 1;
          return {
            kind: "repaired",
            actionId: "shop.search-products",
            fromVersion: 1,
            toVersion: 2,
          };
        },
      ),
    ),
  );
  assert.equal(owners, 1);
  assert.equal(results.filter((result) => result.owned).length, 1);
  assert.equal(results.filter((result) => !result.owned).length, 7);
  assert.equal(
    results.every((result) => result.outcome.kind === "repaired"),
    true,
  );
  assert.equal(flights.size, 0);
});

test("owner exceptions settle waiters and do not poison later flights", async () => {
  const flights = new RepairFlightCoordinator();
  const key = { siteId: "shop.example.com", actionId: "shop.search-products", baseVersion: 1 };
  const first = await Promise.all(
    Array.from({ length: 4 }, () =>
      flights.run(key, async () => {
        throw new Error("repair owner crashed");
      }),
    ),
  );
  assert.equal(
    first.every(
      (result) =>
        result.outcome.kind === "failed" && result.outcome.error === "repair owner crashed",
    ),
    true,
  );
  assert.equal(flights.size, 0);

  const retry = await flights.run(key, async () => ({
    kind: "repaired",
    actionId: key.actionId,
    fromVersion: 1,
    toVersion: 2,
  }));
  assert.equal(retry.owned, true);
  assert.equal(retry.outcome.kind, "repaired");
});

test("a completed v1 flight does not block a later v2 flight", async () => {
  const flights = new RepairFlightCoordinator();
  const v1 = await flights.run(
    { siteId: "shop.example.com", actionId: "shop.search-products", baseVersion: 1 },
    async () => ({
      kind: "failed",
      actionId: "shop.search-products",
      error: "could not patch v1",
    }),
  );
  assert.equal(v1.outcome.kind, "failed");
  const v2 = await flights.run(
    { siteId: "shop.example.com", actionId: "shop.search-products", baseVersion: 2 },
    async () => ({
      kind: "repaired",
      actionId: "shop.search-products",
      fromVersion: 2,
      toVersion: 3,
    }),
  );
  assert.equal(v2.owned, true);
  assert.equal(v2.outcome.kind, "repaired");
});

test("distinct action keys repair independently", async () => {
  const flights = new RepairFlightCoordinator();
  let searchStarted!: () => void;
  let openStarted!: () => void;
  const searchReady = new Promise<void>((resolve) => {
    searchStarted = resolve;
  });
  const openReady = new Promise<void>((resolve) => {
    openStarted = resolve;
  });

  const [search, open] = await Promise.all([
    flights.run(
      { siteId: "shop.example.com", actionId: "shop.search-products", baseVersion: 1 },
      async () => {
        searchStarted();
        await openReady;
        return {
          kind: "repaired",
          actionId: "shop.search-products",
          fromVersion: 1,
          toVersion: 2,
        };
      },
    ),
    flights.run(
      { siteId: "shop.example.com", actionId: "shop.open-product", baseVersion: 1 },
      async () => {
        openStarted();
        await searchReady;
        return {
          kind: "repaired",
          actionId: "shop.open-product",
          fromVersion: 1,
          toVersion: 2,
        };
      },
    ),
  ]);
  assert.equal(search.owned, true);
  assert.equal(open.owned, true);
  assert.equal(search.outcome.kind, "repaired");
  assert.equal(open.outcome.kind, "repaired");
});

test("repair flight keys include site, action id, and version", () => {
  assert.equal(
    formatRepairFlightKey({
      siteId: "https://Shop.Example.com/catalog",
      actionId: "shop.search-products",
      baseVersion: 1,
    }),
    "shop.example.com::shop.search-products@1",
  );
  assert.notEqual(
    formatRepairFlightKey({
      siteId: "shop.example.com",
      actionId: "shop.search-products",
      baseVersion: 1,
    }),
    formatRepairFlightKey({
      siteId: "shop.example.com",
      actionId: "shop.search-products",
      baseVersion: 2,
    }),
  );
});

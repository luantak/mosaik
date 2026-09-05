import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import { css, inputRef, label, role, testId } from "../../core/index.js";
import { startFixtureServer, withBrowser } from "../../runtime/index.js";
import { isCoarseExtractLocator, validateDraftIntegrity } from "../draft-integrity.js";
import { createDiscoveryTools } from "../tools.js";
import { DEFAULT_DISCOVERY_CONSTRAINTS } from "../types.js";

const shop = (name: string) => resolve("fixtures/shop", name);

const request = {
  id: "city-autocomplete",
  task: "Type Por and choose Portland.",
  inputs: { city: "Hamburg" },
  constraints: DEFAULT_DISCOVERY_CONSTRAINTS,
};

function draft(
  steps: Array<
    | {
        id: string;
        type: "navigate";
        url: string;
      }
    | {
        id: string;
        type: "fill";
        locator: ReturnType<typeof label>;
        value: ReturnType<typeof inputRef> | { kind: "literal"; value: string };
      }
    | {
        id: string;
        type: "extract-text";
        locator: ReturnType<typeof css> | ReturnType<typeof testId> | ReturnType<typeof role>;
        output: string;
      }
  >,
) {
  return {
    id: "city-autocomplete",
    version: 1,
    verification: { status: "unverified" as const },
    actions: [
      {
        id: "city-autocomplete/main",
        name: "city-autocomplete",
        steps: steps.map((step) =>
          step.type === "navigate"
            ? { ...step, safety: "browser-local" as const }
            : step.type === "fill"
              ? { ...step, safety: "browser-local" as const }
              : { ...step, safety: "read-only" as const },
        ),
      },
    ],
  };
}

test("unknown input references are rejected before a proposal", () => {
  const result = validateDraftIntegrity({
    automation: draft([
      { id: "open", type: "navigate", url: "http://local/" },
      {
        id: "city",
        type: "fill",
        locator: label("City"),
        value: inputRef("cityPrefix"),
      },
    ]),
    request,
    goalReached: true,
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0]?.type, "unknown-input-reference");
  assert.equal(result.errors[0]?.key, "cityPrefix");
  assert.equal(result.errors[0]?.stepId, "city");
});

test("coarse extract roots are rejected and specific extracts are accepted", () => {
  assert.equal(isCoarseExtractLocator(css("body")), true);
  assert.equal(isCoarseExtractLocator(css("html")), true);
  assert.equal(isCoarseExtractLocator(css("main")), true);
  assert.equal(isCoarseExtractLocator(role("main")), true);
  assert.equal(isCoarseExtractLocator(css("main .price")), false);
  assert.equal(isCoarseExtractLocator(testId("price")), false);
  assert.equal(isCoarseExtractLocator(role("status", { name: "Price" })), false);
  assert.equal(isCoarseExtractLocator(role("main", { name: "Product" })), false);

  const coarse = validateDraftIntegrity({
    automation: draft([
      { id: "open", type: "navigate", url: "http://local/" },
      {
        id: "text",
        type: "extract-text",
        locator: css("body"),
        output: "page",
      },
    ]),
    request,
    goalReached: true,
  });
  assert.equal(coarse.valid, false);
  assert.equal(coarse.errors[0]?.type, "extract-locator-too-coarse");

  const specific = validateDraftIntegrity({
    automation: draft([
      { id: "open", type: "navigate", url: "http://local/" },
      {
        id: "price",
        type: "extract-text",
        locator: testId("price"),
        output: "price",
      },
    ]),
    request,
    goalReached: true,
  });
  assert.equal(specific.valid, true);
});

test("known input refs and compile-valid drafts stay accepted", () => {
  const result = validateDraftIntegrity({
    automation: draft([
      { id: "open", type: "navigate", url: "http://local/" },
      {
        id: "city",
        type: "fill",
        locator: label("City"),
        value: inputRef("city"),
      },
    ]),
    request,
    goalReached: true,
  });
  assert.equal(result.valid, true);
});

test("addStep rejects unknown input refs and coarse extracts before finish", async () => {
  const fixture = await startFixtureServer({ "/": { file: shop("discovery-product.html") } });
  try {
    await withBrowser(async (browser) => {
      const { tools, close } = createDiscoveryTools(browser, {
        id: "mug-price",
        task: "Read the mug price.",
        startUrl: fixture.url,
        inputs: { city: "Hamburg" },
        goal: { type: "text", contains: "$18.00" },
        constraints: DEFAULT_DISCOVERY_CONSTRAINTS,
      });
      try {
        await tools.exploreNavigate({ url: fixture.url });
        await assert.rejects(
          tools.addStep({
            step: {
              id: "city",
              type: "fill",
              safety: "browser-local",
              locator: label("City"),
              value: inputRef("cityPrefix"),
            },
          }),
          /cityPrefix/,
        );
        await assert.rejects(
          tools.addStep({
            step: {
              id: "page",
              type: "extract-text",
              safety: "read-only",
              locator: css("body"),
              output: "page",
            },
          }),
          /document or root/,
        );
        await tools.addStep({
          step: { id: "open", type: "navigate", safety: "browser-local", url: fixture.url },
        });
        await tools.addStep({
          step: {
            id: "price",
            type: "extract-text",
            safety: "read-only",
            locator: testId("price"),
            output: "price",
          },
        });
        const proposal = await tools.finish({ status: "discovered" });
        assert.ok(proposal);
        assert.equal(proposal.verification.status, "unverified");
      } finally {
        await close();
      }
    });
  } finally {
    await fixture.close();
  }
});

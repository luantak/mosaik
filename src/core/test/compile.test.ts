import assert from "node:assert/strict";
import { test } from "vitest";
import { CompileError, compile } from "../compile.js";
import {
  automation,
  click,
  css,
  extractList,
  extractText,
  fill,
  form,
  hrefField,
  inputRef,
  label,
  landmark,
  literalValue,
  navigate,
  role,
  select,
  testId,
  textField,
} from "../dsl.js";
import { resolveStepValue } from "../types.js";

test("DSL compiles to a single-action automation", () => {
  const compiled = automation("checkout", () => [
    navigate({ id: "open", url: "http://127.0.0.1:1/", safety: "browser-local" }),
    fill({ id: "email", locator: label("Email"), value: "a@b.c", safety: "browser-local" }),
    select({ id: "country", locator: label("Country"), value: "DE", safety: "browser-local" }),
    click({
      id: "continue",
      locator: role("button", { name: "Continue" }),
      safety: "browser-local",
    }),
    click({
      id: "place-order",
      locator: role("button", { name: "Place order" }),
      safety: "external-side-effect",
    }),
  ]);

  assert.equal(compiled.id, "checkout");
  assert.equal(compiled.version, 1);
  assert.equal(compiled.actions.length, 1);
  assert.deepEqual(
    compiled.actions[0]?.steps.map((step) => step.id),
    ["open", "email", "country", "continue", "place-order"],
  );
  assert.equal(compiled.actions[0]?.steps[4]?.safety, "external-side-effect");
});

test("compile rejects duplicate step ids and empty locators", () => {
  assert.throws(
    () =>
      automation("dup", () => [
        click({ id: "go", locator: role("button"), safety: "browser-local" }),
        click({ id: "go", locator: role("button", { name: "X" }), safety: "browser-local" }),
      ]),
    CompileError,
  );

  assert.throws(
    () =>
      compile({
        id: "bad",
        version: 1,
        actions: [
          {
            id: "main",
            name: "main",
            steps: [{ id: "go", type: "click", safety: "browser-local", locator: css("") }],
          },
        ],
      }),
    /css locator needs a selector/,
  );
});

test("compile preserves optional locator scope", () => {
  const compiled = automation("scoped", () => [
    fill({
      id: "email",
      locator: label("Email", { within: form("Checkout") }),
      value: "a@b.c",
      safety: "browser-local",
    }),
    click({
      id: "go",
      locator: role("button", { name: "Place order", within: landmark("main") }),
      safety: "external-side-effect",
    }),
    click({
      id: "plain",
      locator: role("button", { name: "Home" }),
      safety: "read-only",
    }),
  ]);
  const email = compiled.actions[0]?.steps[0];
  const order = compiled.actions[0]?.steps[1];
  const home = compiled.actions[0]?.steps[2];
  assert.ok(email?.type === "fill");
  assert.deepEqual(email.locator.within, { kind: "form", name: "Checkout" });
  assert.ok(order?.type === "click");
  assert.deepEqual(order.locator.within, { kind: "landmark", role: "main" });
  assert.equal(order.safety, "external-side-effect");
  assert.ok(home?.type === "click");
  assert.equal(home.locator.within, undefined);
});

test("compile accepts input and literal step values", () => {
  const compiled = automation("checkout", () => [
    fill({
      id: "email",
      locator: label("Email"),
      value: inputRef("email"),
      safety: "browser-local",
    }),
    select({
      id: "country",
      locator: label("Country"),
      value: literalValue("DE"),
      safety: "browser-local",
    }),
  ]);
  const email = compiled.actions[0]?.steps[0];
  const country = compiled.actions[0]?.steps[1];
  assert.ok(email?.type === "fill");
  assert.deepEqual(email.value, { kind: "input", key: "email" });
  assert.ok(country?.type === "select");
  assert.deepEqual(country.value, { kind: "literal", value: "DE" });
});

test("dotted input refs resolve nested product fields", () => {
  assert.equal(
    resolveStepValue({ kind: "input", key: "product.href" }, { product: { href: "/mug" } }),
    "/mug",
  );
});

test("compile accepts extract-text and rejects empty or duplicate outputs", () => {
  const compiled = automation("product", () => [
    navigate({ id: "open", url: "http://127.0.0.1:1/", safety: "browser-local" }),
    extractText({
      id: "price",
      locator: testId("price"),
      output: "price",
      safety: "read-only",
    }),
  ]);
  const step = compiled.actions[0]?.steps[1];
  assert.ok(step?.type === "extract-text");
  assert.equal(step.output, "price");

  assert.throws(
    () =>
      compile({
        id: "empty-output",
        version: 1,
        actions: [
          {
            id: "main",
            name: "main",
            steps: [
              {
                id: "price",
                type: "extract-text",
                safety: "read-only",
                locator: testId("price"),
                output: "",
              },
            ],
          },
        ],
      }),
    /requires an output key/,
  );
  assert.throws(
    () =>
      automation("dup-output", () => [
        extractText({
          id: "was",
          locator: css(".was"),
          output: "price",
          safety: "read-only",
        }),
        extractText({
          id: "now",
          locator: testId("price"),
          output: "price",
          safety: "read-only",
        }),
      ]),
    /Duplicate output key/,
  );
});

test("compile accepts extract-list fields and rejects an empty field map", () => {
  const compiled = automation("catalog", () => [
    extractList({
      id: "products",
      locator: testId("product"),
      output: "products",
      fields: {
        href: hrefField(),
        title: textField(testId("title")),
      },
      safety: "read-only",
    }),
  ]);
  const step = compiled.actions[0]?.steps[0];
  assert.ok(step?.type === "extract-list");
  assert.equal(step.output, "products");
  assert.equal(step.fields.href?.source, "attr");

  assert.throws(
    () =>
      compile({
        id: "empty-fields",
        version: 1,
        actions: [
          {
            id: "main",
            name: "main",
            steps: [
              {
                id: "products",
                type: "extract-list",
                safety: "read-only",
                locator: testId("product"),
                output: "products",
                fields: {},
              },
            ],
          },
        ],
      }),
    /requires extract-list fields/,
  );
});

test("compile rejects incomplete locator scope", () => {
  assert.throws(
    () =>
      compile({
        id: "bad-form",
        version: 1,
        actions: [
          {
            id: "main",
            name: "main",
            steps: [
              {
                id: "email",
                type: "fill",
                safety: "browser-local",
                locator: { strategy: "label", label: "Email", within: { kind: "form", name: "" } },
                value: "a@b.c",
              },
            ],
          },
        ],
      }),
    /form scope needs a name/,
  );
  assert.throws(
    () =>
      compile({
        id: "bad-landmark",
        version: 1,
        actions: [
          {
            id: "main",
            name: "main",
            steps: [
              {
                id: "go",
                type: "click",
                safety: "browser-local",
                locator: {
                  strategy: "role",
                  role: "button",
                  name: "Go",
                  within: { kind: "landmark", role: "" },
                },
              },
            ],
          },
        ],
      }),
    /landmark scope needs a role/,
  );
});

test("input formatting preserves literal punctuation and requires a caller value", () => {
  const value = {
    kind: "input" as const,
    key: "item.number",
    prefix: "Item {",
    suffix: "} [details]",
  };
  assert.equal(resolveStepValue(value, { item: { number: 113 } }), "Item {113} [details]");
  assert.throws(() => resolveStepValue(value, {}), /Missing input: item.number/);
  assert.equal(
    resolveStepValue({ ...value, key: "choice" }, { choice: '$&"[]' }),
    'Item {$&"[]} [details]',
  );
});

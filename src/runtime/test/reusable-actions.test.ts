import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { defineAction } from "../../capabilities/define.js";
import { coerceExtracted } from "../../capabilities/schema.js";
import { emitActionSource, parseActionSource } from "../../library/action-source.js";
import { createPlaywrightHost } from "../../automations/host.js";
import { executeStep } from "../execute.js";
import type { LocatorDefinition, Step } from "../../core/types.js";

const id = { kind: "input" as const, key: "id" };
const edit: LocatorDefinition = {
  strategy: "role",
  role: "button",
  name: "Edit",
  within: {
    kind: "container",
    locator: { strategy: "css", selector: ".row", attribute: { name: "data-id", value: id } },
  },
};
const makeAction = () =>
  defineAction({
    id: "customers.edit",
    siteId: "example.com",
    name: "editCustomer",
    description: "Open a customer editor",
    inputs: { id: { type: "string" } },
    safety: "browser-local",
    precondition: { kind: "count", locator: edit, count: 1 },
    completion: {
      kind: "attribute",
      locator: { strategy: "css", selector: "body" },
      name: "data-edited",
      value: id,
    },
    steps: [{ id: "edit", type: "click", safety: "browser-local", locator: edit }],
  });

test("contracts and input-bound targets survive source round trip", () => {
  const action = makeAction();
  assert.deepEqual(parseActionSource(emitActionSource(action)), action);
  assert.throws(
    () => defineAction({ ...action, steps: action.implementation.steps, inputs: {} }),
    /input reference/,
  );
});

test("numeric parsing follows asserted decimal formats without stripping punctuation", () => {
  assert.equal(
    coerceExtracted({ type: "number", format: "decimal-point" }, "19.99", "price"),
    19.99,
  );
  assert.equal(
    coerceExtracted({ type: "number", format: "decimal-comma" }, "19,99", "price"),
    19.99,
  );
  for (const raw of ["19,99", "", "1,234.56", "$19.99", "abc"])
    assert.throws(() => coerceExtracted({ type: "number" }, raw, "price"));
});

test("bound targets reuse punctuation IDs and reject missing or ambiguous records", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<div class="row" data-id="a"><button>Edit</button></div><div class="row"><button>Edit</button></div>`,
    );
    const unusual = 'b"]\\\n#id';
    await page
      .locator(".row")
      .nth(1)
      .evaluate((el, value) => el.setAttribute("data-id", value), unusual);
    await page.evaluate(() =>
      document
        .querySelectorAll("button")
        .forEach(
          (button) =>
            (button.onclick = () =>
              document.body.setAttribute(
                "data-edited",
                button.parentElement!.getAttribute("data-id")!,
              )),
        ),
    );
    const host = createPlaywrightHost(page, [makeAction()], { timeoutMs: 100 });
    await host.invoke("editCustomer", { id: "a" });
    await host.invoke("editCustomer", { id: unusual });
    assert.equal(await page.locator("body").getAttribute("data-edited"), unusual);
    await assert.rejects(host.invoke("editCustomer", { id: "gone" }), /unsupported-state/);
    await page
      .locator(".row")
      .nth(1)
      .evaluate((el) => el.setAttribute("data-id", "a"));
    const step = makeAction().implementation.steps[0]!;
    assert.equal((await executeStep(page, step, 100, { id: "a" })).ok, false);
    const missing = await executeStep(page, step, 100, {});
    assert.equal(missing.ok ? "" : missing.type, "invalid-input");
  } finally {
    await browser.close();
  }
});

test("search waits for the requested state, permits explicit empty and handles optional fields", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div id="results" data-query="old"><article><h2>Old</h2></article></div>',
    );
    const step: Step = {
      id: "list",
      type: "extract-list",
      safety: "read-only",
      locator: { strategy: "css", selector: "article" },
      output: "items",
      ready: {
        kind: "attribute",
        locator: { strategy: "css", selector: "#results" },
        name: "data-query",
        value: { kind: "input", key: "query" },
      },
      empty: {
        kind: "attribute",
        locator: { strategy: "css", selector: "#results" },
        name: "data-empty",
        value: "true",
      },
      fields: {
        title: { source: "text", locator: { strategy: "css", selector: "h2" } },
        image: {
          source: "attr",
          name: "src",
          locator: { strategy: "css", selector: "img" },
          optional: true,
        },
      },
    };
    await page.evaluate(() => {
      setTimeout(() => {
        document.querySelector("#results")!.setAttribute("data-query", "new");
        document.querySelector("h2")!.textContent = "New";
      }, 80);
    });
    const outcome = await executeStep(page, step, 500, { query: "new" });
    assert.deepEqual(outcome, { ok: true, output: { key: "items", value: [{ title: "New" }] } });
    await page
      .locator("article")
      .evaluate((el) => el.insertAdjacentHTML("beforeend", '<img src="a"><img src="b">'));
    const ambiguousOptional = await executeStep(page, step, 100, { query: "new" });
    assert.match(ambiguousOptional.ok ? "" : ambiguousOptional.message, /field image matched 2/);
    await page
      .locator("article")
      .evaluate((el) => el.querySelectorAll("img").forEach((image) => image.remove()));
    await page.locator("h2").evaluate((el) => el.remove());
    const missing = await executeStep(page, step, 100, { query: "new" });
    assert.match(missing.ok ? "" : missing.message, /Row 0 field title/);
    await page.locator("#results").evaluate((el) => {
      el.innerHTML = "";
      el.setAttribute("data-empty", "true");
    });
    assert.deepEqual(await executeStep(page, step, 100, { query: "new" }), {
      ok: true,
      output: { key: "items", value: [] },
    });
  } finally {
    await browser.close();
  }
});

test("overlapping implementations fail before clicking and unconfirmed clicks are uncertain", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<button>Save</button>");
    const locator: LocatorDefinition = { strategy: "role", role: "button", name: "Save" };
    const step: Step = { id: "save", type: "click", safety: "external-side-effect", locator };
    const implementation = {
      precondition: { kind: "count" as const, locator, count: 1 },
      completion: { kind: "count" as const, locator, count: 0 },
      steps: [step],
    };
    const action = defineAction({
      id: "editor.save",
      siteId: "example.com",
      name: "saveEditor",
      description: "Save the editor",
      safety: "external-side-effect",
      steps: [step],
      implementations: [
        { ...implementation, id: "one" },
        { ...implementation, id: "two" },
      ],
    });
    await assert.rejects(
      createPlaywrightHost(page, [action]).invoke("saveEditor", {}),
      /ambiguous-state/,
    );
    const result = await executeStep(page, { ...step, completion: implementation.completion }, 50);
    assert.equal(result.ok ? "" : result.type, "uncertain-outcome");
  } finally {
    await browser.close();
  }
});

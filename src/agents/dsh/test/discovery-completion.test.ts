import assert from "node:assert/strict";
import { test } from "vitest";
import {
  canCompleteFromDiscovery,
  discoveryHasPerformedMutations,
} from "../discovery-completion.js";
import { defineAction, string } from "../../../capabilities/index.js";
import { click, extractText, navigate, role } from "../../../core/index.js";
const read = defineAction({
  id: "site.read",
  siteId: "example.com",
  name: "readPage",
  description: "Read the current page",
  safety: "read-only",
  outputs: { text: string() },
  steps: [extractText({ id: "read", locator: role("main"), output: "text", safety: "read-only" })],
});

test("simple observed reading does not need a automation replay", () => {
  assert.equal(
    canCompleteFromDiscovery(
      "export default defineAutomation(async () => {const page = await readPage(); return {text:page.text};});",
      [read],
    ),
    true,
  );
});

test("simple read-only navigation does not replay after discovery", () => {
  const open = defineAction({
    id: "site.open",
    siteId: "example.com",
    name: "openEditor",
    description: "Open the editor",
    safety: "read-only",
    steps: [navigate({ id: "open", url: "https://example.com/editor", safety: "read-only" })],
  });
  assert.equal(
    canCompleteFromDiscovery(
      "export default defineAutomation(async () => {await openEditor();});",
      [open],
    ),
    true,
  );
});

test("simple read-only link paths do not replay after discovery", () => {
  const open = defineAction({
    id: "site.open-editor",
    siteId: "example.com",
    name: "openEditor",
    description: "Open the editor through the project page",
    safety: "read-only",
    steps: [
      click({
        id: "open-project",
        locator: role("link", { name: "Project 115" }),
        safety: "read-only",
      }),
      click({ id: "open-editor", locator: role("link", { name: "Editor" }), safety: "read-only" }),
    ],
  });
  assert.equal(
    canCompleteFromDiscovery(
      "export default defineAutomation(async () => {await openEditor();});",
      [open],
    ),
    true,
  );
});
test("loops, file operations and transformations must execute the actual task", () => {
  for (const body of [
    "for(let i=0;i<100;i++){await readPage();}",
    'const page=await readPage(); await ctx.files.download({url:page.text,path:"cover.jpg"});',
    "const page=await readPage(); return page.text.slice(0,10);",
    "const page=await readPage(); return page.text.length + 1;",
    "await readPage(); await readPage();",
    "try {await readPage();} catch {}",
  ])
    assert.equal(
      canCompleteFromDiscovery(`export default defineAutomation(async ctx => {${body}});`, [read]),
      false,
      body,
    );
});

const create = defineAction({
  id: "site.create",
  siteId: "example.com",
  name: "createItem",
  description: "Create an item with an appearance",
  safety: "browser-local",
  steps: [
    click({ id: "add", locator: role("button", { name: "Add" }), safety: "browser-local" }),
    click({ id: "appearance", locator: role("button", { name: "Teal" }), safety: "browser-local" }),
  ],
});
const createSource = "export default defineAutomation(async () => {await createItem({});});";
const receipt = {
  name: "createItem",
  performedClicks: create.implementation.steps.map((step) =>
    step.type === "click" ? step.locator : undefined,
  ),
};

test("a fully observed mutable click workflow goes to review without replay", () => {
  assert.equal(canCompleteFromDiscovery(createSource, [create], [receipt]), true);
});

test("probes, missing clicks, different order and different inputs cannot skip execution", () => {
  for (const observations of [
    [],
    [{ name: "createItem" }],
    [{ ...receipt, performedClicks: receipt.performedClicks.slice(0, 1) }],
    [{ ...receipt, performedClicks: [...receipt.performedClicks].reverse() }],
  ])
    assert.equal(canCompleteFromDiscovery(createSource, [create], observations), false);
  assert.equal(
    canCompleteFromDiscovery(
      createSource.replace("createItem({})", 'createItem({variant:"different"})'),
      [create],
      [receipt],
    ),
    false,
  );
  assert.equal(
    canCompleteFromDiscovery(
      createSource.replace("await createItem({});", "await createItem({}); await readPage();"),
      [create, read],
      [receipt],
    ),
    false,
  );
});

test("an older mutable receipt cannot skip execution after another action", () => {
  assert.equal(
    canCompleteFromDiscovery(createSource, [create], [receipt, { name: "navigateElsewhere" }]),
    false,
  );
});

test("ordered observed mutations with matching property arguments do not replay", () => {
  const color = defineAction({
    id: "site.color",
    siteId: "example.com",
    name: "setColor",
    description: "Set color",
    safety: "browser-local",
    inputs: { label: string() },
    steps: [
      click({
        id: "color",
        safety: "browser-local",
        locator: {
          strategy: "role",
          role: "button",
          exact: true,
          bindings: { name: { kind: "input", key: "label" } },
        },
      }),
    ],
  });
  const source =
    'export default defineAutomation(async () => {await createItem({}); await setColor({label:"Teal"});});';
  const colorReceipt = {
    name: "setColor",
    inputs: { label: "Teal" },
    performedClicks: [{ strategy: "role", role: "button", exact: true, name: "Teal" }],
  };
  assert.equal(canCompleteFromDiscovery(source, [create, color], [receipt, colorReceipt]), true);
  assert.equal(canCompleteFromDiscovery(source, [create, color], [colorReceipt, receipt]), false);
  assert.equal(
    canCompleteFromDiscovery(
      source.replace('label:"Teal"', 'label:"Amber"'),
      [create, color],
      [receipt, colorReceipt],
    ),
    false,
  );
  assert.equal(
    canCompleteFromDiscovery(
      source.replace('label:"Teal"', "label:input.color"),
      [create, color],
      [receipt, colorReceipt],
    ),
    false,
  );
});

test("observed fills match their actual values without a automation replay", () => {
  const action = defineAction({
    id: "site.value",
    siteId: "example.com",
    name: "setValue",
    description: "Set value",
    safety: "browser-local",
    inputs: { value: string() },
    steps: [
      {
        id: "fill",
        type: "fill",
        safety: "browser-local",
        locator: { strategy: "label", label: "Value" },
        value: { kind: "input", key: "value" },
      },
    ],
  });
  const observations = [
    {
      name: "setValue",
      inputs: { value: "#123456" },
      performedOperations: [
        { type: "fill", locator: { strategy: "label", label: "Value" }, value: "#123456" },
      ],
    },
  ];
  const source =
    'export default defineAutomation(async () => {await setValue({value:"#123456"});});';
  assert.equal(canCompleteFromDiscovery(source, [action], observations), true);
  assert.equal(
    canCompleteFromDiscovery(source.replace("#123456", "blue"), [action], observations),
    false,
  );
});

test("setup clicks do not force replay, but duplicate saved mutations cannot be hidden", () => {
  const operations = create.implementation.steps.map((step) => ({
    type: "click",
    locator: step.type === "click" ? step.locator : undefined,
  }));
  assert.equal(
    canCompleteFromDiscovery(
      createSource,
      [create],
      [
        {
          name: create.name,
          performedOperations: [
            { type: "click", locator: role("tab", { name: "Tools" }) },
            ...operations,
          ],
        },
      ],
    ),
    true,
  );
  assert.equal(
    canCompleteFromDiscovery(
      createSource,
      [create],
      [{ name: create.name, performedOperations: [operations[0], ...operations] }],
    ),
    false,
  );
});

test("mismatched discovery receipts prevent replay of already performed edits", () => {
  const create = defineAction({
    id: "site.create",
    siteId: "example.com",
    name: "createItem",
    description: "Create an item",
    safety: "browser-local",
    inputs: { kind: string() },
    outputs: {},
    steps: [
      click({ id: "create", locator: role("button", { name: "Create" }), safety: "browser-local" }),
    ],
  });
  const observations = [
    {
      name: "createItem",
      inputs: { kind: "A" },
      performedOperations: [{ type: "click", locator: role("button", { name: "Create" }) }],
    },
  ];
  assert.equal(
    canCompleteFromDiscovery(
      'export default defineAutomation(async () => { await createItem({kind:"B"}); });',
      [create],
      observations,
    ),
    false,
  );
  assert.equal(discoveryHasPerformedMutations([create], observations), true);
  assert.equal(
    discoveryHasPerformedMutations([create], [{ name: "createItem", performedOperations: [] }]),
    false,
  );
  assert.equal(
    discoveryHasPerformedMutations(
      [read],
      [{ name: read.name, performedOperations: [{ type: "click" }] }],
    ),
    false,
  );
});

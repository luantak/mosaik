import { executeStep } from "../../../runtime/execute.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canCompleteFromDiscovery } from "../discovery-completion.js";
import assert from "node:assert/strict";
import test from "node:test";
import { runActionDiscoveryCode } from "../action-discovery-tools.js";
import { createActionDiscoverySession } from "../../../capabilities/action-discovery.js";
import { createMemoryRegistry } from "../../../capabilities/lookup.js";
import { unwrapCodeModeValue } from "../../../capabilities/code-mode.js";
import { startFixtureServer, withBrowser } from "../../../runtime/index.js";
import { bindLocator, resolveLocator } from "../../../runtime/locators.js";
import type { LocatorDefinition } from "../../../core/types.js";
import { createNavigationObserver } from "../navigation-observation.js";

const tabs = `
  <button role="tab" aria-selected="true" id="overview">Overview</button>
  <button role="tab" aria-selected="false" id="details">Details</button>
  <output id="clicks">0</output>
  <script>
    document.querySelector('#details').onclick = () => {
      document.querySelector('#details').setAttribute('aria-selected', 'true');
      document.querySelector('#overview').setAttribute('aria-selected', 'false');
      document.querySelector('#clicks').textContent = String(Number(document.querySelector('#clicks').textContent) + 1);
    };
  </script>`;

const locatorCode = `const locator = {strategy:"role", role:"tab", name:"Details", exact:true};`;
const candidateCode = `const candidate = {name:"selectDetails", description:"Select the details tab", safety:"browser-local", inputs:[], outputs:[], steps:[{id:"select", type:"click", locator, safety:"browser-local", completion:JSON.stringify({kind:"changed",locator})}]};`;

test("discovery rejects an invented text-change completion without saving or replaying the click", async () => {
  const fixture = await startFixtureServer({ "/": { html: tabs } });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry();
      const session = createActionDiscoverySession({ registry, siteId });
      const result = await runActionDiscoveryCode(
        {
          session,
          browser,
          startUrl: fixture.url,
          task: "Select the details tab",
        },
        `${locatorCode}
        const clicked = await tools.exploreClick({locator});
        if (!clicked.ok || clicked.state.attributes['aria-selected'] !== 'true') throw new Error('Missing observed selection');
        ${candidateCode}
        let error;
        try { await tools.submitAction(candidate); } catch (e) { error = String(e); }
        return {error, clicks: await tools.readText({locator:{strategy:"css",selector:"#clicks"}})};`,
      );
      const value = unwrapCodeModeValue(result.value) as {
        error: string;
        clicks: { text: string };
      };
      assert.match(value.error, /changed completion was not observed/);
      assert.equal(value.clicks.text, "1");
      assert.equal((await registry.list(siteId)).length, 0);
      assert.equal(session.preview().draft.steps.length, 0);
    });
  } finally {
    await fixture.close();
  }
});

for (const alreadySelected of [false, true]) {
  test(`grouped discovery retains a final step's selected-state completion, already selected=${alreadySelected}`, async () => {
    const html = alreadySelected
      ? tabs.replace('aria-selected="false" id="details"', 'aria-selected="true" id="details"')
      : tabs;
    const fixture = await startFixtureServer({ "/": { html } });
    try {
      await withBrowser(async (browser) => {
        const siteId = new URL(fixture.url).host;
        const registry = createMemoryRegistry();
        const makeSession = () => createActionDiscoverySession({ registry, siteId });
        const result = await runActionDiscoveryCode(
          {
            session: makeSession(),
            browser,
            startUrl: fixture.url,
            task: "Select details",
            expectedActionName: "selectDetails",
            prerequisiteActions: [],
            onSaved: async (value) => value,
            nextAction: async () => ({
              session: makeSession(),
              task: "Read details",
              expectedActionName: "readDetails",
              taskInputs: {},
              prerequisiteActions: ["selectDetails"],
              allowRepresentativeItem: false,
              existingActions: await registry.list(siteId),
            }),
          },
          `${locatorCode}
          const completion = {kind:"attribute", locator, name:"aria-selected", value:"true"};
          const clicked = await tools.exploreClick({locator, completion});
          if (!clicked.ok) throw new Error(JSON.stringify(clicked));
          ${candidateCode}
          candidate.steps[0].completion = completion;
          const {nextAction: next} = await tools.submitAction(candidate);
          return {prefix:next.prefix, clicks:await tools.readText({locator:{strategy:"css",selector:"#clicks"}})};`,
        );
        const value = unwrapCodeModeValue(result.value) as {
          prefix: string;
          clicks: { text: string };
        };
        assert.match(value.prefix, /verified current state/);
        assert.equal(value.clicks.text, "1");
      });
    } finally {
      await fixture.close();
    }
  });
}

test("malformed attribute filters give a repairable error before locator binding", () => {
  for (const attribute of [
    { href: "/destination" },
    { name: "href" },
    { name: "href", value: null },
    { name: "href", value: {} },
    { name: "href", value: { kind: "input" } },
  ]) {
    assert.throws(
      () =>
        bindLocator({ strategy: "role", role: "link", attribute } as unknown as LocatorDefinition),
      /Locator attribute requires \{name, value\}/,
    );
  }
});

test("planning supplies an href locator for links with nested accessible labels", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: '<a href="/workspace"><span aria-hidden="true">★</span><span aria-label="Workspace">Open workspace</span></a>',
    },
    "/workspace": { html: "<main>Workspace</main>" },
  });
  try {
    await withBrowser(async (browser) => {
      const observer = createNavigationObserver({ browser, startUrl: fixture.url });
      try {
        const observation = await observer.inspect();
        const link = observation.links[0]!;
        const page = browser.contexts()[0]!.pages()[0]!;
        assert.equal(await resolveLocator(page, link.locator).count(), 1);
        await resolveLocator(page, link.locator).click();
        assert.equal(page.url(), link.href);
      } finally {
        await observer.close();
      }
    });
  } finally {
    await fixture.close();
  }
});

test("a failed click completion is not accepted as evidence and does not repeat the click", async () => {
  const fixture = await startFixtureServer({ "/": { html: tabs } });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry();
      const session = createActionDiscoverySession({ registry, siteId });
      const result = await runActionDiscoveryCode(
        { session, browser, startUrl: fixture.url, task: "Select details" },
        `${locatorCode}
        ${candidateCode}
        const click = await tools.exploreClick({locator, completion:candidate.steps[0].completion});
        let error;
        try { await tools.submitAction(candidate); } catch(e) { error=String(e); }
        return {click,error,clicks:await tools.readText({locator:{strategy:"css",selector:"#clicks"}})};`,
      );
      const value = unwrapCodeModeValue(result.value) as {
        click: { ok: boolean; error: string; actionPerformed?: boolean };
        error: string;
        clicks: { text: string };
      };
      assert.equal(value.click.ok, false);
      assert.equal(value.click.actionPerformed, true);
      assert.match(value.click.error, /unconfirmed/);
      assert.match(value.error, /changed completion was not observed/);
      assert.equal(value.clicks.text, "1");
      assert.equal((await registry.list(siteId)).length, 0);
    });
  } finally {
    await fixture.close();
  }
});

test("grouped discovery retains an observed text change without repeating a non-idempotent click", async () => {
  const fixture = await startFixtureServer({ "/": { html: tabs } });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry();
      const makeSession = () => createActionDiscoverySession({ registry, siteId });
      const result = await runActionDiscoveryCode(
        {
          session: makeSession(),
          browser,
          startUrl: fixture.url,
          task: "Select details",
          expectedActionName: "selectDetails",
          prerequisiteActions: [],
          onSaved: async (value) => value,
          nextAction: async () => ({
            session: makeSession(),
            task: "Read details",
            expectedActionName: "readDetails",
            taskInputs: {},
            prerequisiteActions: ["selectDetails"],
            allowRepresentativeItem: false,
            existingActions: await registry.list(siteId),
          }),
        },
        `${locatorCode}
        ${candidateCode}
        candidate.steps[0].completion = JSON.stringify({kind:"changed",locator:{strategy:"css",selector:"#clicks"}});
        const clicked=await tools.exploreClick({locator,completion:candidate.steps[0].completion});
        if(!clicked.ok) throw new Error(JSON.stringify(clicked));
        const {nextAction: next} = await tools.submitAction(candidate);
        return {prefix:next.prefix, clicks:await tools.readText({locator:{strategy:"css",selector:"#clicks"}})};`,
      );
      const value = unwrapCodeModeValue(result.value) as {
        prefix: string;
        clicks: { text: string };
      };
      assert.match(value.prefix, /verified current state/);
      assert.equal(value.clicks.text, "1");
    });
  } finally {
    await fixture.close();
  }
});

test("ambiguous click and save failures retain scoped alternatives for immediate recovery", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: `
      <fieldset><legend>Background</legend><button onclick="document.querySelector('output').textContent='Background'">Violet</button></fieldset>
      <fieldset><legend>Foreground</legend><button onclick="document.querySelector('output').textContent='Foreground'">Violet</button></fieldset>
      <output>Unchanged</output>`,
    },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry();
      const session = createActionDiscoverySession({ registry, siteId });
      const result = await runActionDiscoveryCode(
        { session, browser, startUrl: fixture.url, task: "Choose a violet background" },
        `
        const locator={strategy:"role",role:"button",name:"Violet",exact:true};
        const failed=await tools.exploreClick({locator});
        const candidate={name:"chooseBackground",description:"Choose a violet background",safety:"browser-local",inputs:[],outputs:[],steps:[{id:"choose",type:"click",safety:"browser-local",locator}]};
        let error;
        try {await tools.submitAction(candidate);} catch(e) {error=String(e);}
        const before=await tools.readText({locator:{strategy:"css",selector:"output"}});
        const alternative=failed.alternatives.find(a=>a.context==='Background');
        if(!alternative) throw new Error(JSON.stringify(failed));
        const tested=await tools.testLocator({locator:alternative.locator});
        if(!tested.ok) throw new Error(JSON.stringify(tested));
        const clicked=await tools.exploreClick({locator:alternative.locator});
        if(!clicked.ok) throw new Error(JSON.stringify(clicked));
        candidate.steps[0].locator=alternative.locator;
        const saved=await tools.submitAction(candidate);
        return {failed,error,before,after:await tools.readText({locator:{strategy:"css",selector:"output"}}),saved};`,
      );
      const value = unwrapCodeModeValue(result.value) as {
        failed: { ok: boolean; error: string };
        error: string;
        before: { text: string };
        after: { text: string };
      };
      assert.equal(value.failed.ok, false);
      assert.doesNotMatch(value.failed.error, /\.nth\(|\.first\(/);
      assert.match(value.error, /Step choose has not been performed/);
      assert.equal(value.before.text, "Unchanged");
      assert.equal(value.after.text, "Background");
      assert.equal((await registry.list(siteId)).length, 1);
    });
  } finally {
    await fixture.close();
  }
});

test("contract correction preserves completed mutations without repeating exploration", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: `<button onclick="document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1)">Add marker</button><label>Value<input></label><output>0</output>`,
    },
  });
  try {
    await withBrowser(async (browser) => {
      const registry = createMemoryRegistry();
      const siteId = new URL(fixture.url).host;
      const session = createActionDiscoverySession({ registry, siteId });
      const result = await runActionDiscoveryCode(
        {
          session,
          browser,
          startUrl: fixture.url,
          task: "Create a purple marker; do not omit its color",
        },
        `
        const add={strategy:"role",role:"button",name:"Add marker",exact:true};
        const value={strategy:"label",label:"Value"};
        await tools.exploreClick({locator:add});
        await tools.exploreFill({locator:value,value:"#800080"});
        const candidate={name:"createMarker",description:"Create a marker",safety:"browser-local",inputs:[{key:"omit",type:"boolean"}],outputs:[],steps:[{id:"add",type:"click",locator:add,safety:"browser-local"},{id:"value",type:"fill",locator:value,value:"#800080",safety:"browser-local"}]};
        let error;
        try{await tools.submitAction(candidate);}catch(e){error=String(e);}
        candidate.inputs=[];
        const saved=await tools.submitAction(candidate);
        const count=await tools.readText({locator:{strategy:"css",selector:"output"}});
        return {error,saved,count};
      `,
      );
      const value = unwrapCodeModeValue(result.value) as { error: string; count: { text: string } };
      assert.match(value.error, /input omit is not used/);
      assert.equal(value.count.text, "1");
      const actions = await registry.list(siteId);
      assert.equal(actions.length, 1);
      assert.deepEqual(actions[0]!.inputs, {});
    });
  } finally {
    await fixture.close();
  }
});

test("discovery corrects a guessed completion and saves the performed click without retesting or replay", async () => {
  const fixture = await startFixtureServer({ "/": { html: tabs } });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry();
      const session = createActionDiscoverySession({ registry, siteId });
      const result = await runActionDiscoveryCode(
        { session, browser, startUrl: fixture.url, task: "Select details" },
        `${locatorCode}
        const wrong = {kind:"attribute",locator,name:"aria-current",value:"page"};
        const click = await tools.exploreClick({locator,completion:JSON.stringify(wrong)});
        const completion = {kind:"attribute",locator,name:"aria-selected",value:"true"};
        const check = await tools.checkCondition({condition:JSON.stringify(completion)});
        const absentBaseline = await tools.checkCondition({condition:JSON.stringify({kind:"changed",locator,attribute:"aria-selected"})});
        await tools.submitAction({name:"selectDetails",description:"Select details",safety:"browser-local",inputs:[],outputs:[],steps:[{id:"select",type:"click",locator,safety:"browser-local",completion:JSON.stringify(completion)}]});
        return {click,check,absentBaseline,clicks:await tools.readText({locator:{strategy:"css",selector:"#clicks"}})};`,
      );
      const value = unwrapCodeModeValue(result.value) as {
        click: {
          ok: boolean;
          actionPerformed?: boolean;
          state: { attributes: Record<string, string> };
          completion: { actual: unknown; matches: number };
        };
        check: { satisfied: boolean };
        absentBaseline: { satisfied: boolean };
        clicks: { text: string };
      };
      assert.equal(value.click.ok, false);
      assert.equal(value.click.actionPerformed, true);
      assert.equal(value.click.state.attributes["aria-selected"], "true");
      assert.equal(value.click.completion.matches, 1);
      assert.equal(value.click.completion.actual, null);
      assert.equal(value.check.satisfied, true);
      assert.equal(value.absentBaseline.satisfied, false);
      assert.equal(value.clicks.text, "1");
      assert.equal((await registry.list(siteId)).length, 1);
    });
  } finally {
    await fixture.close();
  }
});

test("condition inspection reports ambiguous targets and does not perform an action", async () => {
  const fixture = await startFixtureServer({ "/": { html: tabs } });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const session = createActionDiscoverySession({ registry: createMemoryRegistry(), siteId });
      const result = await runActionDiscoveryCode(
        { session, browser, startUrl: fixture.url, task: "Select details" },
        `const check = await tools.checkCondition({condition:JSON.stringify({kind:"attribute",locator:{strategy:"role",role:"tab"},name:"aria-selected",value:"true"})});
        const beforeFailure = await tools.exploreClick({locator:{strategy:"role",role:"tab",name:"Details",exact:true},completion:JSON.stringify({kind:"changed",locator:{strategy:"role",role:"tab"},attribute:"aria-selected"})});
        const failed = await tools.exploreClick({locator:{strategy:"role",role:"tab",name:"Missing",exact:true}});
        return {check,beforeFailure,failed,clicks:await tools.readText({locator:{strategy:"css",selector:"#clicks"}})};`,
      );
      const value = unwrapCodeModeValue(result.value) as {
        check: { satisfied: boolean; observation: { matches: number } };
        beforeFailure: { ok: boolean; actionPerformed?: boolean; completion: { matches: number } };
        failed: { ok: boolean; actionPerformed?: boolean };
        clicks: { text: string };
      };
      assert.equal(value.check.satisfied, false);
      assert.equal(value.check.observation.matches, 2);
      assert.equal(value.beforeFailure.ok, false);
      assert.equal(value.beforeFailure.actionPerformed, undefined);
      assert.equal(value.beforeFailure.completion.matches, 2);
      assert.equal(value.failed.ok, false);
      assert.equal(value.failed.actionPerformed, undefined);
      assert.equal(value.clicks.text, "0");
    });
  } finally {
    await fixture.close();
  }
});

test("created object appearance and actual click receipt survive discovery handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mosaik-click-receipt-"));
  const previous = process.env.DSH_POC_SESSION_DIR;
  process.env.DSH_POC_SESSION_DIR = directory;
  const fixture = await startFixtureServer({
    "/": {
      html: `<button onclick="document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1);document.querySelector('#item').style.backgroundColor='gray'">Add item</button><button onclick="document.querySelector('#item').style.backgroundColor='teal'">Teal</button><div id="item"></div><output>0</output>`,
    },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry();
      const session = createActionDiscoverySession({ registry, siteId });
      await runActionDiscoveryCode(
        { session, browser, startUrl: fixture.url, task: "Create one teal item" },
        `
        const add={strategy:"role",role:"button",name:"Add item",exact:true};
        const appearance={strategy:"role",role:"button",name:"Teal",exact:true};
        await tools.exploreClick({locator:add});
        await tools.exploreClick({locator:appearance});
        const condition=JSON.stringify({kind:"attribute",locator:{strategy:"css",selector:"#item"},name:"style",value:"background-color: teal;"});
        const checked=await tools.checkCondition({condition});
        if(!checked.satisfied) throw new Error("Object appearance did not change");
        return await tools.submitAction({name:"createItem",description:"Create a teal item",inputs:[],outputs:[],safety:"browser-local",steps:[{id:"add",type:"click",locator:add,safety:"browser-local"},{id:"appearance",type:"click",locator:appearance,safety:"browser-local",completion:condition}]});
      `,
      );
      const evidence = JSON.parse(
        await readFile(join(directory, "mosaik-observations.json"), "utf8"),
      );
      assert.equal(evidence.observations[0].performedClicks.length, 2);
      assert.equal(
        canCompleteFromDiscovery(
          "export default defineAutomation(async () => {await createItem({});});",
          await registry.list(siteId),
          evidence.observations,
        ),
        true,
      );
    });
  } finally {
    if (previous === undefined) delete process.env.DSH_POC_SESSION_DIR;
    else process.env.DSH_POC_SESSION_DIR = previous;
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("discovery learns a property input and reuses it on another document with another value", async () => {
  const html = `<button onclick="document.querySelector('output').textContent='teal'">Teal</button><button onclick="document.querySelector('output').textContent='amber'">Amber</button><output>unset</output>`;
  const fixture = await startFixtureServer({
    "/documents/17": { html },
    "/documents/28": { html },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry();
      const session = createActionDiscoverySession({ registry, siteId });
      await runActionDiscoveryCode(
        { session, browser, startUrl: fixture.origin + "/documents/17", task: "Apply teal" },
        `
        await tools.setExampleInputs({values:JSON.stringify({choiceLabel:"Teal"})});
        const locator={strategy:"role",role:"button",exact:true,bindings:{name:{kind:"input",key:"choiceLabel"}}};
        await tools.exploreClick({locator});
        return await tools.submitAction({name:"setAppearance",description:"Set the current object's appearance",contexts:["Current document"],inputs:[{key:"choiceLabel",type:"string"}],outputs:[],safety:"browser-local",steps:[{id:"choose",type:"click",locator,safety:"browser-local"}]});
      `,
      );
      const action = (await registry.list(siteId))[0]!;
      assert.deepEqual(action.contexts, ["Current document"]);
      assert.deepEqual(Object.keys(action.inputs), ["choiceLabel"]);
      assert.equal(JSON.stringify(action.implementation).includes("Teal"), false);
      const page = await browser.newPage();
      await page.goto(fixture.origin + "/documents/28");
      for (const step of action.implementation.steps)
        assert.equal((await executeStep(page, step, 1500, { choiceLabel: "Amber" })).ok, true);
      assert.equal(await page.locator("output").textContent(), "amber");
      await page.close();
    });
  } finally {
    await fixture.close();
  }
});

test("missing creation is reported separately without performing it", async () => {
  const fixture = await startFixtureServer({ "/": { html: "<button>Add item</button>" } });
  try {
    await withBrowser(async (browser) => {
      const registry = createMemoryRegistry();
      const siteId = new URL(fixture.url).host;
      const result = await runActionDiscoveryCode(
        {
          session: createActionDiscoverySession({ registry, siteId }),
          browser,
          startUrl: fixture.url,
          task: "Select item",
          expectedActionName: "selectItem",
        },
        'return await tools.requireCapability({name:"addItem",intent:"Create a missing item before selecting it"});',
      );
      const value = unwrapCodeModeValue(result.value) as { status: string; reason: string };
      assert.equal(value.status, "refused");
      assert.match(value.reason, /separate capability addItem.*selectItem/);
      assert.equal((await registry.list(siteId)).length, 0);
    });
  } finally {
    await fixture.close();
  }
});

test("discovery clicks and saves an observed reference without model-authored locators", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: '<fieldset><legend>Primary</legend><button onclick="document.querySelector(&quot;output&quot;).textContent=&quot;primary&quot;">Apply</button></fieldset><fieldset><legend>Secondary</legend><button onclick="document.querySelector(&quot;output&quot;).textContent=&quot;secondary&quot;">Apply</button></fieldset><output>none</output>',
    },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry();
      const result = await runActionDiscoveryCode(
        {
          session: createActionDiscoverySession({ registry, siteId }),
          browser,
          startUrl: fixture.url,
          task: "Apply secondary",
        },
        `
      const overview=await tools.getOverview({full:true});
      const target=overview.elements.find(item=>item.label==="Apply" && item.context==="Secondary");
      if(!target) throw new Error("No secondary target");
      const clicked=await tools.exploreClick({elementRef:target.elementRef,expectedLabel:target.label});
      if(!clicked.ok) throw new Error(JSON.stringify(clicked));
      return await tools.submitAction({name:"applySecondary",description:"Apply secondary settings",safety:"browser-local",inputs:[],outputs:[],steps:[{id:"apply",type:"click",elementRef:target.elementRef,expectedLabel:target.label,safety:"browser-local",completion:JSON.stringify({kind:"enabled",elementRef:target.elementRef,value:true})}]});
    `,
      );
      assert.ok(result.value);
      const action = (await registry.list(siteId))[0]!;
      assert.equal(action.implementation.steps.length, 1);
      assert.equal(JSON.stringify(action).includes("elementRef"), false);
      assert.equal(JSON.stringify(action).includes("Secondary"), true);
    });
  } finally {
    await fixture.close();
  }
});

test("batch advancement never replays a saved creation with absent or expired completion", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: "<button onclick=\"document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1);this.disabled=true\">Create</button><output>0</output>",
    },
  });
  try {
    await withBrowser(async (browser) => {
      const registry = createMemoryRegistry();
      const siteId = new URL(fixture.url).host;
      const makeSession = () => createActionDiscoverySession({ registry, siteId });
      const result = await runActionDiscoveryCode(
        {
          session: makeSession(),
          browser,
          startUrl: fixture.url,
          task: "Create an item then inspect it",
          expectedActionName: "createItem",
          onSaved: async (value) => value,
          nextAction: async () => ({
            session: makeSession(),
            task: "Read item",
            expectedActionName: "readItem",
            taskInputs: {},
            prerequisiteActions: ["createItem"],
            allowRepresentativeItem: false,
            existingActions: await registry.list(siteId),
          }),
        },
        `
      const locator={strategy:"role",role:"button",name:"Create",exact:true};
      const clicked=await tools.exploreClick({locator});
      if(!clicked.ok) throw new Error(JSON.stringify(clicked));
      const {nextAction: next} = await tools.submitAction({name:"createItem",description:"Create one item",safety:"browser-local",inputs:[],outputs:[],steps:[{id:"create",type:"click",locator,safety:"browser-local"}]});
      const count=await tools.readText({locator:{strategy:"css",selector:"output"}});
      return {next,count};
    `,
      );
      const value = unwrapCodeModeValue(result.value) as {
        next: { expectedActionName: string; prefix: string };
        count: { text: string };
      };
      assert.equal(value.next.expectedActionName, "readItem");
      assert.match(value.next.prefix, /not replayed/);
      assert.equal(value.count.text, "1");
    });
  } finally {
    await fixture.close();
  }
});

test("grouped discovery cannot advance past a mutation that was only located", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: "<button onclick=\"document.querySelector('output').textContent='1'\">Create</button><output>0</output>",
    },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry();
      const makeSession = () => createActionDiscoverySession({ registry, siteId });
      const result = await runActionDiscoveryCode(
        {
          session: makeSession(),
          browser,
          startUrl: fixture.url,
          task: "Create then configure",
          expectedActionName: "createItem",
          onSaved: async (value) => value,
          nextAction: async () => ({
            session: makeSession(),
            task: "Configure",
            expectedActionName: "configureItem",
            taskInputs: {},
            prerequisiteActions: ["createItem"],
            allowRepresentativeItem: false,
            existingActions: await registry.list(siteId),
          }),
        },
        `
      const locator={strategy:"role",role:"button",name:"Create",exact:true};
      await tools.testLocator({locator});
      const candidate={name:"createItem",description:"Create one item",safety:"browser-local",inputs:[],outputs:[],steps:[{id:"create",type:"click",locator,safety:"browser-local"}]};
      let error;try{await tools.submitAction(candidate);}catch(e){error=String(e);}
      const before=await tools.readText({locator:{strategy:"css",selector:"output"}});
      await tools.exploreClick({locator});
      const {nextAction: next} = await tools.submitAction(candidate);
      return {error,before,next,after:await tools.readText({locator:{strategy:"css",selector:"output"}})};
    `,
      );
      const value = unwrapCodeModeValue(result.value) as {
        error: string;
        before: { text: string };
        after: { text: string };
        next: { expectedActionName: string };
      };
      assert.match(value.error, /has not been performed/);
      assert.equal(value.before.text, "0");
      assert.equal(value.after.text, "1");
      assert.equal(value.next.expectedActionName, "configureItem");
    });
  } finally {
    await fixture.close();
  }
});

test("discovery saves a formatted numeric choice and reuses it for another item", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: "<button onclick=\"document.querySelector('output').textContent='7'\">Open item 7 details</button><button onclick=\"document.querySelector('output').textContent='113'\">Open item 113 details</button><output>none</output>",
    },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry();
      const result = await runActionDiscoveryCode(
        {
          session: createActionDiscoverySession({ registry, siteId }),
          browser,
          startUrl: fixture.url,
          task: "Open item 7",
        },
        `
        await tools.setExampleInputs({values:JSON.stringify({itemNumber:7})});
        const locator={strategy:"role",role:"button",name:"Open item 7 details",bindings:{name:{kind:"input",key:"itemNumber",prefix:"Open item ",suffix:" details"}}};
        const clicked=await tools.exploreClick({locator});
        if(!clicked.ok) throw new Error(JSON.stringify(clicked));
        return await tools.submitAction({name:"openItem",description:"Open the requested item",safety:"read-only",inputs:[{key:"itemNumber",type:"number"}],outputs:[],steps:[{id:"open",type:"click",locator,safety:"read-only"}]});
      `,
      );
      assert.ok(result);
      const action = (await registry.list(siteId))[0]!;
      const { emitActionSource, parseActionSource } =
        await import("../../../library/action-source.js");
      const saved = parseActionSource(emitActionSource(action));
      const step = saved.implementation.steps[0]!;
      assert.equal(step.type, "click");
      if (step.type !== "click") throw new Error("Expected click");
      const page = await browser.newPage();
      try {
        await page.goto(fixture.url);
        await resolveLocator(page, step.locator, { itemNumber: 113 }).click();
        assert.equal(await page.locator("output").textContent(), "113");
      } finally {
        await page.close();
      }
    });
  } finally {
    await fixture.close();
  }
});

test("production discovery retains panel activation and reuses same-node click evidence", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: `<button role="tab" onclick="document.querySelector('section').hidden=false">Tools</button><section aria-label="Tools" hidden><button onclick="document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1)">Insert 7</button></section><output>0</output>`,
    },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const registry = createMemoryRegistry();
      const result = await runActionDiscoveryCode(
        {
          session: createActionDiscoverySession({ registry, siteId }),
          browser,
          startUrl: fixture.url,
          task: "Insert item 7",
        },
        `
        const tab={strategy:"role",role:"tab",name:"Tools"};
        await tools.exploreClick({locator:tab});
        const overview=await tools.getOverview({full:true});
        const target=overview.elements.find(x=>x.label==="Insert 7");
        let mismatch;
        try { await tools.exploreClick({elementRef:target.elementRef,expectedLabel:"Insert 8"}); }
        catch(e) { mismatch=String(e); }
        await tools.exploreClick({elementRef:target.elementRef,expectedLabel:"Insert 7"});
        await tools.setExampleInputs({values:JSON.stringify({itemNumber:"7"})});
        const locator={strategy:"role",role:"button",name:"Insert ",exact:false,bindings:{name:{kind:"input",key:"itemNumber",prefix:"Insert "}}};
        const candidate={name:"insertItem",description:"Insert an item",safety:"browser-local",inputs:[{key:"itemNumber",type:"number"}],outputs:[],steps:[{id:"insert",type:"click",locator}]};
        let missingSetup;
        try { await tools.submitAction(candidate); } catch(e) { missingSetup=String(e); }
        candidate.steps.unshift({id:"tools",type:"click",locator:tab});
        await tools.submitAction(candidate);
        return {mismatch,missingSetup,count:await tools.readText({locator:{strategy:"css",selector:"output"}})};
      `,
      );
      const value = unwrapCodeModeValue(result.value) as {
        mismatch: string;
        missingSetup: string;
        count: { text: string };
      };
      assert.match(value.mismatch, /No action was performed/);
      assert.match(value.missingSetup, /Include the explored tab activation/);
      assert.equal(value.count.text, "1");
      const action = (await registry.list(siteId))[0]!;
      assert.equal(action.implementation.steps.length, 2);
    });
  } finally {
    await fixture.close();
  }
});

test("a navigation click returns the destination controls without another overview call", async () => {
  const fixture = await startFixtureServer({
    "/": { html: '<a href="/details">Open details</a>' },
    "/details": { html: '<h1>Details</h1><a href="/edit">Open editor</a>' },
  });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const result = await runActionDiscoveryCode(
        {
          session: createActionDiscoverySession({ registry: createMemoryRegistry(), siteId }),
          browser,
          startUrl: fixture.url,
          task: "Open editor",
        },
        `return await tools.exploreClick({locator:{strategy:"role",role:"link",name:"Open details"}});`,
      );
      const value = unwrapCodeModeValue(result.value) as {
        overview: { url: string; elements: Array<{ label: string }> };
      };
      assert.equal(value.overview.url, new URL("/details", fixture.url).href);
      assert.ok(value.overview.elements.some((item) => item.label === "Open editor"));
    });
  } finally {
    await fixture.close();
  }
});

test("absolute link filters report the literal href without guessing a replacement", async () => {
  const fixture = await startFixtureServer({ "/": { html: '<a href="/editor">Open editor</a>' } });
  try {
    await withBrowser(async (browser) => {
      const siteId = new URL(fixture.url).host;
      const result = await runActionDiscoveryCode(
        {
          session: createActionDiscoverySession({ registry: createMemoryRegistry(), siteId }),
          browser,
          startUrl: fixture.url,
          task: "Open editor",
        },
        `return await tools.testLocator({locator:{strategy:"role",role:"link",name:"Open editor",attribute:{name:"href",value:${JSON.stringify(new URL("/editor", fixture.url).href)}}}});`,
      );
      const value = unwrapCodeModeValue(result.value) as {
        ok: boolean;
        attributeTargets: Array<{ href: string; destinationUrl: string }>;
      };
      assert.equal(value.ok, false);
      assert.deepEqual(
        value.attributeTargets.map(({ href, destinationUrl }) => ({ href, destinationUrl })),
        [{ href: "/editor", destinationUrl: new URL("/editor", fixture.url).href }],
      );
    });
  } finally {
    await fixture.close();
  }
});

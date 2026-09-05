import { discoveryEvidenceIsCurrent } from "../../agents/dsh/discovery-evidence.js";
import { executeStep } from "../execute.js";
import { runActionDiscoveryCode } from "../../agents/dsh/action-discovery-tools.js";
import { createActionDiscoverySession, createMemoryRegistry } from "../../capabilities/index.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  openBrowserSession,
  openAgentBrowser,
  sharedAgentPage,
  pageTargetId,
  browserSessionEnvironment,
} from "../session.js";
import { createNavigationObserver } from "../../agents/dsh/navigation-observation.js";
import { startFixtureServer } from "../index.js";

test("planning and discovery attach the invocation page and preserve local state after disconnect", async () => {
  const fixture = await startFixtureServer({
    "/": { html: '<main><h1>Home</h1><a href="/next">Next</a></main>' },
    "/next": { html: "<h1>Next</h1>" },
  });
  const session = await openBrowserSession({ headless: true });
  const previousEndpoint = process.env.MOSAIK_CDP_WS_URL;
  const previousTarget = process.env.MOSAIK_CDP_TARGET_ID;
  try {
    await session.withPage(async (page) => {
      await page.goto(fixture.url);
      await page.evaluate(() => sessionStorage.setItem("invocation", "retained"));
      const other = await page.context().newPage();
      await other.goto(fixture.url);
      Object.assign(
        process.env,
        browserSessionEnvironment({ ...session, cdpTargetId: await pageTargetId(page) }),
      );
      const observer = createNavigationObserver({ startUrl: fixture.url });
      const snapshot = await observer.inspect();
      await observer.inspect(snapshot.links[0]!.href);
      assert.match(page.url(), /\/next$/);
      const destination = page.url();
      const completion = {
        kind: "url" as const,
        value: { kind: "input" as const, key: "destination" },
      };
      const evidence = {
        success: true,
        logs: [],
        actionCalls: [],
        discoveryObservations: [{ page: destination, inputs: { destination }, completion }],
      };
      assert.equal(await discoveryEvidenceIsCurrent(page, evidence), true);
      await observer.inspect(fixture.url);
      assert.equal(page.url(), fixture.url);
      assert.equal(await discoveryEvidenceIsCurrent(page, evidence), false);
      // Execute the saved navigation in this same tab when planning has moved it.
      assert.equal(
        (
          await executeStep(
            page,
            { id: "open", type: "navigate", url: destination, safety: "read-only", completion },
            1500,
            { destination },
          )
        ).ok,
        true,
      );
      assert.equal(await discoveryEvidenceIsCurrent(page, evidence), true);
      await observer.close();
      assert.equal(page.context().pages().length, 2);
      assert.match(page.url(), /\/next$/);
      assert.equal(other.url(), fixture.url);
      const attached = await openAgentBrowser();
      const shared = await sharedAgentPage(attached);
      assert.ok(shared);
      assert.equal(await shared.evaluate(() => sessionStorage.getItem("invocation")), "retained");
      const registry = createMemoryRegistry();
      const draft = createActionDiscoverySession({ registry, siteId: new URL(fixture.url).host });
      await page
        .locator("h1")
        .evaluate((element) => (element.textContent = "Preserved planning state"));
      await runActionDiscoveryCode(
        {
          session: draft,
          browser: attached,
          startUrl: fixture.url,
          task: "Read the current heading",
        },
        `
        const before = await tools.getCurrentUrl({});
        if (!before.url.endsWith("/next")) throw new Error("Discovery reset the planning page");
        await tools.exploreNavigate({url: before.url});
        const preview = await tools.readText({locator:{strategy:"role",role:"heading"}});
        if (preview.text !== "Preserved planning state") throw new Error("Discovery reloaded the current URL");
        return await tools.submitAction({name:"readHeading",description:"Read the current page heading",safety:"read-only",inputs:[],outputs:[{key:"heading",type:"string"}],steps:[{id:"read",type:"extract-text",output:"heading",previewId:preview.previewId}]});
      `,
      );
      assert.equal((await registry.list(new URL(fixture.url).host))[0]?.verification, "unverified");
      await attached.close();
      assert.equal(page.isClosed(), false);
    });
  } finally {
    if (previousEndpoint === undefined) delete process.env.MOSAIK_CDP_WS_URL;
    else process.env.MOSAIK_CDP_WS_URL = previousEndpoint;
    if (previousTarget === undefined) delete process.env.MOSAIK_CDP_TARGET_ID;
    else process.env.MOSAIK_CDP_TARGET_ID = previousTarget;
    await session.close();
    await fixture.close();
  }
});

test("the attached invocation page does not race its owner when a dialog opens", async () => {
  const fixture = await startFixtureServer({
    "/": {
      html: '<button id="arm">Arm</button><script>document.querySelector("#arm").onclick=()=>{window.onbeforeunload=()=>"leave?"}</script>',
    },
    "/next": { html: "<h1>Next</h1>" },
  });
  const session = await openBrowserSession({ headless: true });
  const previousEndpoint = process.env.MOSAIK_CDP_WS_URL;
  const previousTarget = process.env.MOSAIK_CDP_TARGET_ID;
  try {
    await session.withPage(async (page) => {
      await page.goto(fixture.url);
      await page.locator("#arm").click();
      Object.assign(
        process.env,
        browserSessionEnvironment({ ...session, cdpTargetId: await pageTargetId(page) }),
      );
      const attached = await openAgentBrowser();
      try {
        const shared = await sharedAgentPage(attached);
        assert.ok(shared);
        await shared.goto(new URL("/next", fixture.url).href);
        assert.match(shared.url(), /\/next$/);
      } finally {
        await attached.close();
      }
    });
  } finally {
    if (previousEndpoint === undefined) delete process.env.MOSAIK_CDP_WS_URL;
    else process.env.MOSAIK_CDP_WS_URL = previousEndpoint;
    if (previousTarget === undefined) delete process.env.MOSAIK_CDP_TARGET_ID;
    else process.env.MOSAIK_CDP_TARGET_ID = previousTarget;
    await session.close();
    await fixture.close();
  }
});

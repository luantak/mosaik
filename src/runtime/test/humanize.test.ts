import assert from "node:assert/strict";
import { test, vi } from "vitest";

const ghostPathOverride = vi.hoisted(() => ({
  create: undefined as
    | ((
        start: { x: number; y: number },
        end: { x: number; y: number },
      ) => Array<{ x: number; y: number }>)
    | undefined,
}));

vi.mock("ghost-cursor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ghost-cursor")>();
  return {
    ...actual,
    path: (...args: Parameters<typeof actual.path>) =>
      ghostPathOverride.create?.(args[0], args[1]) ?? actual.path(...args),
  };
});

import {
  configurePageHumanization,
  enablePageHumanization,
  humanizedClick,
  humanizedFill,
  humanizedSelectOption,
  withHumanizedWait,
} from "../humanize.js";
import {
  DEFAULT_STEP_TIMEOUT_MS,
  HUMANIZED_STEP_TIMEOUT_ALLOWANCE_MS,
  executeStep,
} from "../execute.js";
import { waitCondition } from "../conditions.js";
import { HUMANIZED_CURSOR_TIMING, humanizedCursorRouteDurationMs } from "../humanize-timing.js";
import {
  blockKeyboardGuardInstallAfterBrowserSide,
  blockMethodUntilReleased,
  deferred,
  delayMethod,
  keyboardGuardRegistrySize,
  requireProtocolEntry,
  withBrowserPage,
} from "./humanize.support.js";

test("disabled execution keeps the original timeout and humanization adds only its allowance", () => {
  assert.equal(DEFAULT_STEP_TIMEOUT_MS, 1_500);
  assert.equal(HUMANIZED_STEP_TIMEOUT_ALLOWANCE_MS, 1_000);
});

test("humanized clicks follow a multi-point mouse path and hold the button", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <style>button { position: absolute; left: 700px; top: 420px; width: 140px; height: 60px; }</style>
      <button>Continue</button>
      <script>
        window.events = [];
        for (const type of ["mousemove", "mousedown", "mouseup", "click"]) {
          document.addEventListener(type, event => window.events.push({
            type,
            x: event.clientX,
            y: event.clientY,
            time: performance.now()
          }));
        }
      </script>
    `);
    enablePageHumanization(page, { idle: false });

    await humanizedClick(page, page.getByRole("button", { name: "Continue" }), { timeout: 3_000 });

    const events = await page.evaluate(
      () =>
        (
          window as unknown as {
            events: Array<{ type: string; x: number; y: number; time: number }>;
          }
        ).events,
    );
    const moves = events.filter((event) => event.type === "mousemove");
    const down = events.find((event) => event.type === "mousedown");
    const up = events.find((event) => event.type === "mouseup");
    assert.ok(moves.length > 3, `expected a curved path, got ${moves.length} move events`);
    assert.ok(
      moves[0]!.x < 600,
      `pointer moved to target before approach: ${JSON.stringify(moves)}`,
    );
    assert.ok(down && up);
    assert.ok(up.time - down.time >= 20, `expected a held click, got ${up.time - down.time}ms`);
    assert.equal(events.filter((event) => event.type === "click").length, 1);
    assert.ok(down.x >= 700 && down.x <= 840);
    assert.ok(down.y >= 420 && down.y <= 480);
  });
});

test("humanized clicks dispatch every generated ghost-cursor point", async () => {
  await withBrowserPage(async (page) => {
    ghostPathOverride.create = (start, end) =>
      Array.from({ length: 20 }, (_, index) => ({
        x: start.x + ((end.x - start.x) * (index + 1)) / 20,
        y: start.y + ((end.y - start.y) * (index + 1)) / 20,
      }));
    try {
      await page.setContent(
        '<button style="position:absolute;left:400px;top:280px;width:100px;height:40px">Continue</button>',
      );
      enablePageHumanization(page, { idle: false });
      const originalMove = page.mouse.move.bind(page.mouse);
      let moveCalls = 0;
      page.mouse.move = async (...args) => {
        moveCalls += 1;
        await originalMove(...args);
      };

      await humanizedClick(page, page.locator("button"), { timeout: 5_000 });

      assert.equal(moveCalls, 20);
    } finally {
      ghostPathOverride.create = undefined;
    }
  });
});

test("humanized clicks continue from a caller-positioned pointer without jumping to center", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <button style="position:absolute;left:700px;top:420px;width:140px;height:60px">Continue</button>
      <script>
        window.moves = [];
        document.addEventListener("mousemove", event => window.moves.push({ x: event.clientX, y: event.clientY }));
      </script>
    `);
    await page.mouse.move(10, 10);
    enablePageHumanization(page, { idle: false });
    await page.evaluate(() => ((window as unknown as { moves: unknown[] }).moves = []));

    await humanizedClick(page, page.getByRole("button", { name: "Continue" }), { timeout: 3_000 });

    const moves = await page.evaluate(
      () => (window as unknown as { moves: Array<{ x: number; y: number }> }).moves,
    );
    assert.ok(moves.length > 3);
    assert.ok(
      Math.hypot(moves[0]!.x - 10, moves[0]!.y - 10) < 150,
      `pointer jumped before its curved approach: ${JSON.stringify(moves)}`,
    );
  });
});

test("humanized clicks wait for delayed click-initiated navigation to settle", async () => {
  await withBrowserPage(async (page) => {
    await page.route("https://example.test/next", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({ status: 200, contentType: "text/html", body: "<main>Arrived</main>" });
    });
    await page.setContent(`
      <button style="position:absolute;left:700px;top:420px;width:140px;height:60px">Continue</button>
      <script>
        document.querySelector("button").addEventListener("click", () => {
          setTimeout(() => { location.href = "https://example.test/next"; }, 50);
        });
      </script>
    `);
    enablePageHumanization(page, { idle: false });

    await humanizedClick(page, page.getByRole("button", { name: "Continue" }), { timeout: 3_000 });

    assert.equal(page.url(), "https://example.test/next");
    assert.equal(await page.locator("main").textContent(), "Arrived");
  });
});

test("humanized clicks do not wait for a navigation timeout when no navigation starts", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(
      '<button style="position:absolute;left:700px;top:420px;width:140px;height:60px">Continue</button>',
    );
    enablePageHumanization(page, { idle: false });
    const started = Date.now();

    await humanizedClick(page, page.getByRole("button", { name: "Continue" }), { timeout: 5_000 });

    assert.ok(Date.now() - started < 2_500, "ordinary click waited for the navigation timeout");
  });
});

test("humanized clicks reject targets inside aria-disabled ancestors without pointer input", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <div role="button" aria-disabled="true" style="position:absolute;left:650px;top:400px;padding:30px">
        <span id="target">Continue</span>
      </div>
      <script>
        window.events = [];
        for (const type of ["mousemove", "mousedown", "click"])
          document.addEventListener(type, () => window.events.push(type));
      </script>
    `);
    enablePageHumanization(page, { idle: false });

    await assert.rejects(
      humanizedClick(page, page.locator("#target"), { timeout: 2_000 }),
      /actionable/,
    );

    assert.deepEqual(
      await page.evaluate(() => (window as unknown as { events: string[] }).events),
      [],
    );
  });
});

test.each(["target", "ancestor"] as const)(
  "humanized clicks reject when the %s becomes aria-disabled during mouse movement",
  async (disabledElement) => {
    await withBrowserPage(async (page) => {
      await page.setContent(`
        <div id="ancestor">
          <button id="target" style="position:absolute;left:700px;top:420px;width:140px;height:60px">Continue</button>
        </div>
        <script>
          window.downs = 0;
          window.armed = true;
          document.addEventListener("mousemove", () => {
            if (!window.armed) return;
            window.armed = false;
            document.querySelector("#${disabledElement}").setAttribute("aria-disabled", "true");
          });
          document.addEventListener("mousedown", () => window.downs += 1);
        </script>
      `);
      enablePageHumanization(page, { idle: false });

      await assert.rejects(
        humanizedClick(page, page.locator("#target"), { timeout: 3_000 }),
        /actionable|disabled/,
      );
      assert.equal(await page.evaluate(() => (window as unknown as { downs: number }).downs), 0);
    });
  },
);

test("false configuration tracks caller moves before later humanization", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <button style="position:absolute;left:700px;top:420px;width:140px;height:60px">Continue</button>
      <script>
        window.moves = [];
        document.addEventListener("mousemove", event => window.moves.push({ x: event.clientX, y: event.clientY }));
      </script>
    `);
    await configurePageHumanization(page, false);
    await page.mouse.move(10, 10);
    await configurePageHumanization(page, true, { idle: false });
    await page.evaluate(() => ((window as unknown as { moves: unknown[] }).moves = []));

    await humanizedClick(page, page.getByRole("button"), { timeout: 3_000 });

    const [firstMove] = await page.evaluate(
      () => (window as unknown as { moves: Array<{ x: number; y: number }> }).moves,
    );
    assert.ok(firstMove);
    assert.ok(
      Math.hypot(firstMove.x - 10, firstMove.y - 10) < 2,
      `first humanized route did not continue from the tracked pointer: ${JSON.stringify(firstMove)}`,
    );
  });
});

test("explicit false configuration disables a previously humanized caller-owned page", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <button style="position:absolute;left:700px;top:420px;width:140px;height:60px">Continue</button>
      <script>window.moves = 0; document.addEventListener("mousemove", () => window.moves += 1);</script>
    `);
    await configurePageHumanization(page, true, { idle: false });
    await humanizedClick(page, page.getByRole("button"), { timeout: 3_000 });
    assert.ok(await page.evaluate(() => (window as unknown as { moves: number }).moves));

    await configurePageHumanization(page, false);
    await page.evaluate(() => ((window as unknown as { moves: number }).moves = 0));
    await humanizedClick(page, page.getByRole("button"), { timeout: 1_500 });

    assert.equal(await page.evaluate(() => (window as unknown as { moves: number }).moves), 1);
  });
});

test("humanized clicks reject an obscured target without clicking the obstruction", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <button id="target" style="position:absolute;left:700px;top:420px;width:140px;height:60px">Continue</button>
      <button id="cover" style="position:absolute;left:700px;top:420px;width:140px;height:60px">Cover</button>
      <script>
        window.coverClicks = 0;
        document.querySelector("#cover").addEventListener("click", () => window.coverClicks += 1);
      </script>
    `);
    enablePageHumanization(page, { idle: false });

    await assert.rejects(
      humanizedClick(page, page.locator("#target"), { timeout: 2_000 }),
      /actionable/,
    );
    assert.equal(
      await page.evaluate(() => (window as unknown as { coverClicks: number }).coverClicks),
      0,
    );
  });
});

test("executeStep diagnoses humanized click failures before mouse down", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <button id="target" style="position:absolute;left:700px;top:420px;width:140px;height:60px">Continue</button>
      <button style="position:absolute;left:700px;top:420px;width:140px;height:60px">Cover</button>
    `);
    enablePageHumanization(page, { idle: false });

    const outcome = await executeStep(
      page,
      {
        id: "continue",
        type: "click",
        safety: "browser-local",
        locator: { strategy: "css", selector: "#target" },
      },
      1_500,
    );

    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.type, "unknown");
      assert.equal(outcome.actionPerformed, undefined);
    }
  });
});

test("executeStep keeps humanized click failures after mouse down uncertain", async () => {
  await withBrowserPage(async (page) => {
    ghostPathOverride.create = (_start, end) => [end];
    try {
      await page.setContent(`
        <button style="position:absolute;left:440px;top:290px;width:80px;height:40px">Continue</button>
        <script>
          window.downs = 0;
          document.addEventListener("mousedown", () => window.downs += 1);
        </script>
      `);
      enablePageHumanization(page, { idle: false });
      const mouse = page.mouse as unknown as { up: () => Promise<void> };
      mouse.up = async () => {
        throw new Error("forced failure after mouse down");
      };

      const outcome = await executeStep(
        page,
        {
          id: "continue",
          type: "click",
          safety: "browser-local",
          locator: { strategy: "role", role: "button", name: "Continue" },
        },
        5_000,
      );

      assert.equal(await page.evaluate(() => (window as unknown as { downs: number }).downs), 1);
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.type, "uncertain-outcome");
        assert.equal(outcome.actionPerformed, true);
      }
    } finally {
      ghostPathOverride.create = undefined;
    }
  });
});

test("executeStep classifies a timed-out initiated mouse down as an uncertain outcome", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <button style="position:absolute;left:440px;top:290px;width:80px;height:40px">Continue</button>
      <script>window.downs = 0; document.addEventListener("mousedown", () => window.downs += 1);</script>
    `);
    enablePageHumanization(page, { idle: false });
    const delayedDown = blockMethodUntilReleased(page.mouse, "down");

    const operation = executeStep(
      page,
      {
        id: "continue",
        type: "click",
        safety: "browser-local",
        locator: { strategy: "role", role: "button", name: "Continue" },
      },
      5_000,
    );
    await requireProtocolEntry(delayedDown.entered, operation);
    const outcome = await operation;

    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.type, "uncertain-outcome");
      assert.equal(outcome.actionPerformed, true);
    }
    delayedDown.release();
    await delayedDown.settled;
    assert.equal(await page.evaluate(() => (window as unknown as { downs: number }).downs), 1);
  });
});

test("humanized click timeout covers movement and click cadence", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(
      '<button style="position:absolute;left:700px;top:420px;width:140px;height:60px">Continue</button>',
    );
    enablePageHumanization(page, { idle: false });
    const started = Date.now();

    await assert.rejects(
      humanizedClick(page, page.getByRole("button", { name: "Continue" }), { timeout: 500 }),
      /timeout|timed out/i,
    );

    assert.ok(Date.now() - started < 900, "click exceeded its single timeout deadline");
  });
});

test("humanized fills focus with the mouse and type with variable per-key timing", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <style>input { position: absolute; left: 620px; top: 360px; width: 220px; height: 40px; }</style>
      <input value="old value">
      <script>
        window.keys = [];
        document.querySelector("input").addEventListener("keydown", event => {
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
            window.keys.push({ key: event.key, time: performance.now() });
          }
        });
      </script>
    `);
    enablePageHumanization(page, { idle: false });

    await humanizedFill(page, page.locator("input"), "hello", { timeout: 5_000 });

    assert.equal(await page.locator("input").inputValue(), "hello");
    const keys = await page.evaluate(
      () => (window as unknown as { keys: Array<{ key: string; time: number }> }).keys,
    );
    assert.deepEqual(
      keys.map((event) => event.key),
      ["h", "e", "l", "l", "o"],
    );
    const intervals = keys.slice(1).map((event, index) => event.time - keys[index]!.time);
    assert.ok(intervals.every((interval) => interval >= 20));
    assert.ok(new Set(intervals.map(Math.round)).size > 1, "expected non-uniform key timing");
  });
});

test.each([
  {
    name: "becomes disabled",
    mutate: "target.disabled = true;",
  },
  {
    name: "becomes readonly",
    mutate: "target.readOnly = true;",
  },
  {
    name: "inherits aria-disabled",
    mutate: 'target.parentElement.setAttribute("aria-disabled", "true");',
  },
  {
    name: "becomes obscured at the pointer",
    mutate: `
      const cover = document.createElement("button");
      cover.style.cssText = "position:absolute;left:10px;top:10px;width:100px;height:40px";
      document.body.append(cover);
    `,
  },
  {
    name: "is replaced by another focused control",
    mutate: `
      const replacement = target.cloneNode();
      target.replaceWith(replacement);
      replacement.focus();
    `,
  },
])(
  "humanized fill sends no keyboard input when its target $name after click",
  async ({ mutate }) => {
    await withBrowserPage(async (page) => {
      ghostPathOverride.create = (_start, end) => [end];
      try {
        await page.setContent(`
        <div>
          <input id="target" value="old" style="position:absolute;left:10px;top:10px;width:100px;height:40px">
        </div>
        <script>
          window.keys = 0;
          const target = document.querySelector("#target");
          target.addEventListener("click", () => { ${mutate} });
          document.addEventListener("keydown", () => window.keys += 1);
        </script>
      `);
        enablePageHumanization(page, { idle: false });

        await assert.rejects(
          humanizedFill(page, page.locator("#target"), "new", { timeout: 5_000 }),
          /disabled|editable|actionable|focus|visible/,
        );

        assert.equal(await page.evaluate(() => (window as unknown as { keys: number }).keys), 0);
      } finally {
        ghostPathOverride.create = undefined;
      }
    });
  },
);

test.each([
  { name: "initial selection", delayedKey: "ControlOrMeta+A" },
  { name: "initial Backspace", delayedKey: "Backspace" },
])(
  "a delayed timed-out humanized fill $name cannot affect a replacement document",
  async ({ delayedKey }) => {
    await withBrowserPage(async (page) => {
      ghostPathOverride.create = (_start, end) => [end];
      const unhandled: unknown[] = [];
      const recordUnhandled = (error: unknown): void => {
        unhandled.push(error);
      };
      process.on("unhandledRejection", recordUnhandled);
      try {
        await page.setContent(`
          <input id="target" value="old" style="position:absolute;left:10px;top:10px;width:100px;height:40px">
        `);
        enablePageHumanization(page, { idle: false });
        const target = page.locator("#target");
        const intendedTarget = await target.elementHandle();
        assert.ok(intendedTarget);
        target.elementHandle = async () => intendedTarget;

        const originalTargetPress = intendedTarget.press.bind(intendedTarget);
        let calls = 0;
        const entered = deferred();
        const released = deferred();
        const settled = deferred();
        const delayPress = async (key: string, operation: () => Promise<void>): Promise<void> => {
          if (key !== delayedKey) {
            await operation();
            return;
          }
          calls += 1;
          entered.resolve();
          await released.promise;
          try {
            await operation();
          } finally {
            settled.resolve();
          }
        };
        intendedTarget.press = async (key, options) =>
          delayPress(key, () => originalTargetPress(key, options));

        const operation = humanizedFill(page, target, "new", { timeout: 5_000 });
        await requireProtocolEntry(entered.promise, operation);
        await assert.rejects(operation, /timeout|timed out/i);
        assert.equal(calls, 1);
        await page.setContent(`
          <input id="other" value="unchanged">
          <script>
            window.events = [];
            for (const type of ["keydown", "keypress", "beforeinput", "input", "keyup", "click"])
              document.addEventListener(type, event => window.events.push(event.type), true);
          </script>
        `);
        await page.locator("#other").focus();
        await page.locator("#other").evaluate((element) => {
          const input = element as HTMLInputElement;
          input.setSelectionRange(input.value.length, input.value.length);
        });
        released.resolve();
        await settled.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.deepEqual(
          await page.evaluate(() => {
            const input = document.querySelector("#other") as HTMLInputElement;
            return {
              events: (window as unknown as { events: string[] }).events,
              value: input.value,
              selection: [input.selectionStart, input.selectionEnd],
            };
          }),
          { events: [], value: "unchanged", selection: [9, 9] },
        );
        assert.deepEqual(unhandled, []);
      } finally {
        process.off("unhandledRejection", recordUnhandled);
        ghostPathOverride.create = undefined;
      }
    });
  },
);

test("humanized fill timeout covers the full typing cadence", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(
      '<input style="position:absolute;left:400px;top:280px;width:100px;height:40px">',
    );
    enablePageHumanization(page, { idle: false });
    const started = Date.now();

    await assert.rejects(
      humanizedFill(
        page,
        page.locator("input"),
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
        { timeout: 3_000 },
      ),
      /timeout|timed out/i,
    );

    assert.ok(Date.now() - started < 3_600, "fill exceeded its single timeout deadline");
  });
});

test("a timed-out per-character fill cannot type into a replacement document", async () => {
  await withBrowserPage(async (page) => {
    ghostPathOverride.create = (_start, end) => [end];
    const unhandled: unknown[] = [];
    const recordUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", recordUnhandled);
    try {
      await page.setContent(`
        <input id="target" style="position:absolute;left:10px;top:10px;width:100px;height:40px">
      `);
      enablePageHumanization(page, { idle: false });
      const target = page.locator("#target");
      const intendedTarget = await target.elementHandle();
      assert.ok(intendedTarget);
      target.elementHandle = async () => intendedTarget;

      const originalTargetType = intendedTarget.type.bind(intendedTarget);

      let calls = 0;
      const entered = deferred();
      const released = deferred();
      const settled = deferred();
      const delayType = async (operation: () => Promise<void>): Promise<void> => {
        calls += 1;
        entered.resolve();
        await released.promise;
        try {
          await operation();
        } finally {
          settled.resolve();
        }
      };
      intendedTarget.type = async (...args) => delayType(() => originalTargetType(...args));

      const operation = humanizedFill(page, target, "S", { timeout: 5_000 });
      await requireProtocolEntry(entered.promise, operation);
      await assert.rejects(operation, /timeout|timed out/i);
      assert.equal(calls, 1);
      await page.setContent(`
        <input id="other" value="unchanged">
        <script>
          window.events = [];
          for (const type of ["keydown", "keypress", "beforeinput", "input", "keyup", "click"])
            document.addEventListener(type, event => window.events.push(event.type), true);
        </script>
      `);
      await page.locator("#other").focus();
      released.resolve();
      await settled.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.deepEqual(
        await page.evaluate(() => ({
          events: (window as unknown as { events: string[] }).events,
          value: (document.querySelector("#other") as HTMLInputElement).value,
        })),
        { events: [], value: "unchanged" },
      );
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
      ghostPathOverride.create = undefined;
    }
  });
});

test("humanized fills fail if typing focus leaves the intended control", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <input id="target" style="position:absolute;left:620px;top:360px;width:220px;height:40px">
      <input id="other">
      <script>
        const target = document.querySelector("#target");
        target.addEventListener("input", () => {
          if (target.value.length === 1) document.querySelector("#other").focus();
        });
      </script>
    `);
    enablePageHumanization(page, { idle: false });

    await assert.rejects(
      humanizedFill(page, page.locator("#target"), "hello", { timeout: 5_000 }),
      /lost focus/,
    );
    assert.equal(await page.locator("#other").inputValue(), "");
  });
});

test("humanized fill mismatch errors do not expose form values", async () => {
  await withBrowserPage(async (page) => {
    const secret = "unique-secret-7b26a9";
    await page.setContent(`
      <input id="target" style="position:absolute;left:620px;top:360px;width:220px;height:40px">
      <script>
        const target = document.querySelector("#target");
        target.addEventListener("input", () => { target.value = "actual-private-value-913f"; });
      </script>
    `);
    enablePageHumanization(page, { idle: false });

    await assert.rejects(
      humanizedFill(page, page.locator("#target"), secret, { timeout: 15_000 }),
      (error: Error) => {
        assert.match(error.message, /value did not match/);
        assert.ok(!error.message.includes(secret));
        assert.ok(!error.message.includes("actual-private-value-913f"));
        return true;
      },
    );
  });
});

test("humanized waits make bounded idle movements and stop before returning", async () => {
  await withBrowserPage(async (page) => {
    ghostPathOverride.create = (start, end) =>
      Array.from({ length: 4 }, (_, index) => ({
        x: start.x + ((end.x - start.x) * (index + 1)) / 4,
        y: start.y + ((end.y - start.y) * (index + 1)) / 4,
      }));
    try {
      await page.setContent(`
        <main style="width: 100vw; height: 100vh"></main>
        <script>
          window.moves = [];
          document.addEventListener("mousemove", event => window.moves.push({
            x: event.clientX,
            y: event.clientY
          }));
        </script>
      `);
      enablePageHumanization(page, {
        idle: true,
        idleInitialDelayMs: [0, 0],
        idleIntervalMs: [10, 10],
        idleMoveChance: 1,
        idleWheelChance: 0,
        idleMaxDistance: 40,
      });
      await page.mouse.move(450, 300);
      await page.evaluate(() => ((window as unknown as { moves: unknown[] }).moves = []));
      const originalMove = page.mouse.move.bind(page.mouse);
      let moveCalls = 0;
      const secondMove = deferred();
      page.mouse.move = async (...args) => {
        await originalMove(...args);
        moveCalls += 1;
        if (moveCalls === 2) secondMove.resolve();
      };

      await withHumanizedWait(page, () => secondMove.promise);
      const finishedCount = await page.evaluate(
        () => (window as unknown as { moves: Array<{ x: number; y: number }> }).moves.length,
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      const laterCount = await page.evaluate(
        () => (window as unknown as { moves: Array<{ x: number; y: number }> }).moves.length,
      );
      assert.ok(finishedCount > 1, "expected idle mouse movement during the wait");
      assert.equal(laterCount, finishedCount);
    } finally {
      ghostPathOverride.create = undefined;
    }
  });
});

test("idle mouse and wheel input interleave, stop, and later clicks restore visibility", async () => {
  await withBrowserPage(async (page) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.75);
    ghostPathOverride.create = (start, end) =>
      Array.from({ length: 20 }, (_, index) => ({
        x: start.x + ((end.x - start.x) * (index + 1)) / 20,
        y: start.y + ((end.y - start.y) * (index + 1)) / 20,
      }));
    try {
      await page.setContent(`
        <body style="height:3600px">
          <button style="position:absolute;left:360px;top:980px;width:160px;height:50px">Continue</button>
          <script>
            window.events = [];
            window.clicked = false;
            for (const type of ["wheel", "mousemove", "click", "keydown", "input"])
              document.addEventListener(type, event => window.events.push(event.type));
            document.querySelector("button").addEventListener("click", () => window.clicked = true);
          </script>
        </body>
      `);
      await page.evaluate(() => scrollTo(0, 900));
      enablePageHumanization(page, {
        idleInitialDelayMs: [0, 0],
        idleIntervalMs: [12, 12],
        idleMoveChance: 1,
        idleWheelChance: 1,
        idleMaxDistance: 40,
      });
      await page.mouse.move(450, 300);
      const protocolEvents: string[] = [];
      const originalMove = page.mouse.move.bind(page.mouse);
      const originalWheel = page.mouse.wheel.bind(page.mouse);
      let wheelCalls = 0;
      const fifthWheel = deferred();
      page.mouse.move = async (...args) => {
        protocolEvents.push("move");
        await originalMove(...args);
      };
      page.mouse.wheel = async (...args) => {
        protocolEvents.push("wheel");
        await originalWheel(...args);
        wheelCalls += 1;
        if (wheelCalls === 5) fifthWheel.resolve();
      };

      await withHumanizedWait(page, () => fifthWheel.promise);
      const afterWait = await page.evaluate(() => ({
        events: (window as unknown as { events: string[] }).events,
        scrollY,
        targetBottom: document.querySelector("button")!.getBoundingClientRect().bottom,
      }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.ok(afterWait.events.filter((event) => event === "wheel").length > 1);
      assert.ok(
        afterWait.targetBottom < 12,
        `idle wheel did not move the later target away: ${JSON.stringify(afterWait)}`,
      );
      assert.equal(
        (await page.evaluate(() => (window as unknown as { events: string[] }).events)).length,
        afterWait.events.length,
        "idle input continued after withHumanizedWait returned",
      );
      const firstWheel = protocolEvents.indexOf("wheel");
      const lastWheel = protocolEvents.lastIndexOf("wheel");
      assert.ok(protocolEvents.slice(firstWheel + 1, lastWheel).includes("move"));
      assert.deepEqual(
        afterWait.events.filter((event) => !["wheel", "mousemove"].includes(event)),
        [],
      );

      await humanizedClick(page, page.getByRole("button", { name: "Continue" }), {
        timeout: 5_000,
      });
      assert.equal(
        await page.evaluate(() => (window as unknown as { clicked: boolean }).clicked),
        true,
      );
      assert.ok((await page.evaluate(() => scrollY)) < afterWait.scrollY);
    } finally {
      ghostPathOverride.create = undefined;
      random.mockRestore();
    }
  });
});

test("idle behavior retains a deterministic stillness path", async () => {
  await withBrowserPage(async (page) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
    try {
      await page.setContent(
        '<body style="height:3000px"><main style="width:100vw;height:100vh"></main></body>',
      );
      enablePageHumanization(page, {
        idleInitialDelayMs: [0, 0],
        idleIntervalMs: [5, 5],
      });
      await page.mouse.move(450, 300);
      const events: string[] = [];
      const originalMove = page.mouse.move.bind(page.mouse);
      const originalWheel = page.mouse.wheel.bind(page.mouse);
      page.mouse.move = async (...args) => {
        events.push("move");
        await originalMove(...args);
      };
      page.mouse.wheel = async (...args) => {
        events.push("wheel");
        await originalWheel(...args);
      };

      await withHumanizedWait(page, () => new Promise((resolve) => setTimeout(resolve, 80)));

      assert.deepEqual(events, []);
    } finally {
      random.mockRestore();
    }
  });
});

test("idle wheel scrolling can move up", async () => {
  await withBrowserPage(async (page) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.25);
    try {
      await page.setContent(
        '<body style="height:4000px"><main style="height:4000px"></main></body>',
      );
      await page.evaluate(() => scrollTo(0, 1_500));
      enablePageHumanization(page, {
        idleInitialDelayMs: [0, 0],
        idleIntervalMs: [1_000, 1_000],
        idleMoveChance: 0,
        idleWheelChance: 1,
      });
      const deltas: number[] = [];
      const originalWheel = page.mouse.wheel.bind(page.mouse);
      const thirdWheel = deferred();
      page.mouse.wheel = async (deltaX, deltaY) => {
        deltas.push(deltaY);
        await originalWheel(deltaX, deltaY);
        if (deltas.length === 3) thirdWheel.resolve();
      };

      await withHumanizedWait(page, () => thirdWheel.promise);

      assert.ok(deltas.length >= 3);
      assert.ok(
        deltas.every((delta) => Math.sign(delta) === -1),
        JSON.stringify(deltas),
      );
    } finally {
      random.mockRestore();
    }
  });
});

test("idle movement dispatches every generated ghost-cursor point", async () => {
  await withBrowserPage(async (page) => {
    ghostPathOverride.create = (start, end) =>
      Array.from({ length: 20 }, (_, index) => ({
        x: start.x + ((end.x - start.x) * (index + 1)) / 20,
        y: start.y + ((end.y - start.y) * (index + 1)) / 20,
      }));
    try {
      await page.setContent('<main style="width:100vw;height:100vh"></main>');
      enablePageHumanization(page, {
        idleInitialDelayMs: [0, 0],
        idleIntervalMs: [1_000, 1_000],
        idleMoveChance: 1,
        idleWheelChance: 0,
        idleMaxDistance: 40,
      });
      await page.mouse.move(450, 300);
      const originalMove = page.mouse.move.bind(page.mouse);
      let moveCalls = 0;
      const routeComplete = deferred();
      page.mouse.move = async (...args) => {
        moveCalls += 1;
        await originalMove(...args);
        if (moveCalls === 20) routeComplete.resolve();
      };

      await withHumanizedWait(page, () => routeComplete.promise);

      assert.equal(moveCalls, 20);
    } finally {
      ghostPathOverride.create = undefined;
    }
  });
});

test("withHumanizedWait awaits an in-flight Playwright idle move before returning", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <main style="width:100vw;height:100vh"></main>
      <script>window.moves = 0; document.addEventListener("mousemove", () => window.moves += 1);</script>
    `);
    enablePageHumanization(page, {
      idleInitialDelayMs: [0, 0],
      idleIntervalMs: [0, 0],
      idleMoveChance: 1,
      idleWheelChance: 0,
      idleMaxDistance: 40,
    });
    await page.mouse.move(450, 300);
    const originalMove = page.mouse.move.bind(page.mouse);
    let idleMoveCalls = 0;
    page.mouse.move = async (...args) => {
      idleMoveCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 900));
      await originalMove(...args);
    };
    const started = Date.now();

    const result = await withHumanizedWait(page, async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return "operation-result";
    });
    const returnedAt = Date.now();
    const returnedMoves = await page.evaluate(() => (window as unknown as { moves: number }).moves);
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(result, "operation-result");
    assert.ok(idleMoveCalls > 0, "idle movement bypassed page.mouse.move");
    assert.ok(returnedAt - started >= 850, "returned before the in-flight idle move settled");
    assert.equal(
      await page.evaluate(() => (window as unknown as { moves: number }).moves),
      returnedMoves,
    );
  });
});

test("idle movement rejects a route that crosses an interactive element", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <button style="position:fixed;left:440px;top:292px;width:20px;height:4px;padding:0">Top</button>
      <button style="position:fixed;left:440px;top:304px;width:20px;height:4px;padding:0">Bottom</button>
      <button style="position:fixed;left:440px;top:296px;width:4px;height:8px;padding:0">Left</button>
      <button style="position:fixed;left:456px;top:296px;width:4px;height:8px;padding:0">Right</button>
      <script>
        window.moves = 0;
        document.addEventListener("mousemove", () => window.moves += 1);
      </script>
    `);
    enablePageHumanization(page, {
      idleInitialDelayMs: [0, 0],
      idleIntervalMs: [10, 10],
      idleMoveChance: 1,
      idleWheelChance: 0,
      idleMaxDistance: 40,
    });
    await page.mouse.move(450, 300);
    await page.evaluate(() => ((window as unknown as { moves: number }).moves = 0));

    await withHumanizedWait(page, () => new Promise((resolve) => setTimeout(resolve, 250)));

    assert.equal(await page.evaluate(() => (window as unknown as { moves: number }).moves), 0);
  });
});

test("idle movement aborts when the DOM makes the route unsafe during dispatch", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <main style="width:100vw;height:100vh"></main>
      <script>
        window.moves = 0;
        window.armed = false;
        document.addEventListener("mousemove", () => {
          window.moves += 1;
          if (window.armed && window.moves === 1) {
            const blocker = document.createElement("button");
            blocker.textContent = "Dynamic blocker";
            blocker.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh";
            document.body.append(blocker);
          }
        });
      </script>
    `);
    enablePageHumanization(page, {
      idleInitialDelayMs: [0, 0],
      idleIntervalMs: [10, 10],
      idleMoveChance: 1,
      idleWheelChance: 0,
      idleMaxDistance: 40,
    });
    await page.mouse.move(450, 300);
    await page.evaluate(() => {
      const state = window as unknown as { moves: number; armed: boolean };
      state.moves = 0;
      state.armed = true;
    });

    await withHumanizedWait(page, () => new Promise((resolve) => setTimeout(resolve, 250)));

    assert.equal(await page.evaluate(() => (window as unknown as { moves: number }).moves), 1);
  });
});

test("humanized scrolling interleaves curved cursor movement with wheel input", async () => {
  await withBrowserPage(async (page) => {
    ghostPathOverride.create = (start, end) =>
      Array.from({ length: 12 }, (_, index) => ({
        x: start.x + ((end.x - start.x) * (index + 1)) / 12,
        y: start.y + ((end.y - start.y) * (index + 1)) / 12,
      }));
    try {
      await page.setContent(`
        <body style="height:2600px">
          <button style="position:absolute;left:360px;top:2200px;width:160px;height:50px">Load more</button>
          <script>window.clicked = false; document.querySelector("button").onclick = () => window.clicked = true;</script>
        </body>
      `);
      enablePageHumanization(page, { idle: false });
      const events: string[] = [];
      const wheelDeltas: number[] = [];
      const originalMove = page.mouse.move.bind(page.mouse);
      const originalWheel = page.mouse.wheel.bind(page.mouse);
      page.mouse.move = async (...args) => {
        events.push("move");
        await originalMove(...args);
      };
      page.mouse.wheel = async (...args) => {
        events.push("wheel");
        wheelDeltas.push(args[1]);
        await originalWheel(...args);
      };

      await humanizedClick(page, page.getByRole("button", { name: "Load more" }), {
        timeout: 5_000,
      });

      const firstWheel = events.indexOf("wheel");
      const lastWheel = events.lastIndexOf("wheel");
      assert.ok(firstWheel >= 0 && lastWheel > firstWheel, JSON.stringify(events));
      assert.ok(
        events.slice(firstWheel + 1, lastWheel).includes("move"),
        `expected cursor movement between wheel events: ${JSON.stringify(events)}`,
      );
      assert.ok(wheelDeltas.length > 3);
      assert.ok(new Set(wheelDeltas.map(Math.round)).size > 2);
      assert.equal(
        await page.evaluate(() => (window as unknown as { clicked: boolean }).clicked),
        true,
      );
    } finally {
      ghostPathOverride.create = undefined;
    }
  });
});

test("humanized clicks horizontally scroll distant targets into view", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <style>
        body { width: 2600px; height: 600px; }
        button { position: absolute; left: 2200px; top: 300px; width: 160px; height: 50px; }
      </style>
      <button onclick="window.clicked = true">Continue</button>
      <script>
        window.horizontalWheels = [];
        window.clicked = false;
        document.addEventListener("wheel", event => window.horizontalWheels.push(event.deltaX));
      </script>
    `);
    enablePageHumanization(page, { idle: false });

    await humanizedClick(page, page.getByRole("button", { name: "Continue" }), {
      timeout: 5_000,
    });

    const result = await page.evaluate(() => ({
      clicked: (window as unknown as { clicked: boolean }).clicked,
      wheels: (window as unknown as { horizontalWheels: number[] }).horizontalWheels,
      scrollX,
    }));
    assert.equal(result.clicked, true);
    assert.ok(result.scrollX > 1_000);
    assert.ok(result.wheels.filter((delta) => delta !== 0).length > 3);
  });
});

test("idle shutdown awaits a companion wheel when cursor drift fails", async () => {
  await withBrowserPage(async (page) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.75);
    try {
      await page.setContent(
        '<body style="height:3000px"><main style="width:100vw;height:100vh"></main></body>',
      );
      enablePageHumanization(page, {
        idleInitialDelayMs: [0, 0],
        idleIntervalMs: [1_000, 1_000],
        idleMoveChance: 1,
        idleWheelChance: 1,
        idleMaxDistance: 40,
      });
      await page.mouse.move(450, 300);
      const moveFailed = deferred();
      page.mouse.move = async () => {
        moveFailed.resolve();
        throw new Error("idle cursor transport failed");
      };
      const wheelEntered = deferred();
      const wheelReleased = deferred();
      page.mouse.wheel = async () => {
        wheelEntered.resolve();
        await wheelReleased.promise;
      };
      let returned = false;

      const waiting = withHumanizedWait(page, async () => {
        await Promise.all([wheelEntered.promise, moveFailed.promise]);
        return "operation-result";
      }).then((value) => {
        returned = true;
        return value;
      });
      await wheelEntered.promise;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const returnedBeforeRelease = returned;
      wheelReleased.resolve();

      assert.equal(await waiting, "operation-result");
      assert.equal(returnedBeforeRelease, false);
    } finally {
      random.mockRestore();
    }
  });
});

test("humanized selects approach the control before choosing an option", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <style>select { position: absolute; left: 680px; top: 400px; width: 150px; height: 40px; }</style>
      <select><option value="one">One</option><option value="two">Two</option></select>
      <script>
        window.moves = 0;
        document.addEventListener("mousemove", () => window.moves += 1);
      </script>
    `);
    enablePageHumanization(page, { idle: false });

    await humanizedSelectOption(page, page.locator("select"), "two", { timeout: 5_000 });

    assert.equal(await page.locator("select").inputValue(), "two");
    assert.ok(
      (await page.evaluate(() => (window as unknown as { moves: number }).moves)) > 3,
      "expected movement toward the select",
    );
  });
});

test.each(["select", "ancestor"] as const)(
  "humanized selects recheck the %s aria-disabled state after mouse movement before mouse down",
  async (disabledElement) => {
    await withBrowserPage(async (page) => {
      await page.setContent(`
        <div id="ancestor">
          <select id="select" style="position:absolute;left:680px;top:400px;width:150px;height:40px">
            <option value="one">One</option>
            <option value="two">Two</option>
          </select>
        </div>
        <script>
          window.downs = 0;
          window.armed = true;
          document.addEventListener("mousemove", () => {
            if (!window.armed) return;
            window.armed = false;
            document.querySelector("#${disabledElement}").setAttribute("aria-disabled", "true");
          });
          document.addEventListener("mousedown", () => window.downs += 1);
        </script>
      `);
      enablePageHumanization(page, { idle: false });

      await assert.rejects(
        humanizedSelectOption(page, page.locator("select"), "two", { timeout: 3_000 }),
        /disabled|actionable/,
      );
      assert.equal(await page.evaluate(() => (window as unknown as { downs: number }).downs), 0);
    });
  },
);

test("humanized selects reject inherited aria-disabled state before pointer input", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <div aria-disabled="true">
        <select style="position:absolute;left:400px;top:280px;width:140px;height:40px">
          <option value="one">One</option>
          <option value="two">Two</option>
        </select>
      </div>
      <script>
        window.downs = 0;
        document.addEventListener("mousedown", () => window.downs += 1);
      </script>
    `);
    enablePageHumanization(page, { idle: false });

    await assert.rejects(
      humanizedSelectOption(page, page.locator("select"), "two", { timeout: 3_000 }),
      /disabled|actionable/,
    );
    assert.equal(await page.evaluate(() => (window as unknown as { downs: number }).downs), 0);
  });
});

test("humanized selects reject a focused replacement created during mousedown", async () => {
  await withBrowserPage(async (page) => {
    ghostPathOverride.create = (_start, end) => [end];
    try {
      await page.setContent(`
        <select id="select" style="position:absolute;left:10px;top:10px;width:140px;height:40px">
          <option value="one">One</option>
          <option value="two">Two</option>
        </select>
        <script>
          const original = document.querySelector("#select");
          window.originalSelect = original;
          original.addEventListener("mousedown", event => {
            event.preventDefault();
            const replacement = original.cloneNode(true);
            original.replaceWith(replacement);
            replacement.focus();
          });
        </script>
      `);
      enablePageHumanization(page, { idle: false });

      await assert.rejects(
        humanizedSelectOption(page, page.locator("#select"), "two", { timeout: 5_000 }),
        /focus|actionable|disabled/,
      );

      assert.deepEqual(
        await page.evaluate(() => ({
          original: (window as unknown as { originalSelect: HTMLSelectElement }).originalSelect
            .value,
          replacement: (document.querySelector("#select") as HTMLSelectElement).value,
        })),
        { original: "one", replacement: "one" },
      );
    } finally {
      ghostPathOverride.create = undefined;
    }
  });
});

test("humanized selects stop before keyboard input when mouse handlers redirect focus", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <select style="position:absolute;left:400px;top:280px;width:140px;height:40px">
        <option value="one">One</option>
        <option value="two">Two</option>
      </select>
      <button id="other">Unrelated action</button>
      <script>
        window.otherClicks = 0;
        const select = document.querySelector("select");
        const other = document.querySelector("#other");
        select.addEventListener("mousedown", event => {
          event.preventDefault();
          other.focus();
        });
        other.addEventListener("click", () => window.otherClicks += 1);
      </script>
    `);
    enablePageHumanization(page, { idle: false });

    await assert.rejects(
      humanizedSelectOption(page, page.locator("select"), "two", { timeout: 5_000 }),
      /focus|actionable/,
    );

    assert.equal(
      await page.evaluate(() => (window as unknown as { otherClicks: number }).otherClicks),
      0,
    );
  });
});

test("a pending timed-out select press cannot reach a replacement document", async () => {
  await withBrowserPage(async (page) => {
    ghostPathOverride.create = (_start, end) => [end];
    const unhandled: unknown[] = [];
    const recordUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", recordUnhandled);
    try {
      await page.setContent(`
        <select id="select" style="position:absolute;left:10px;top:10px;width:140px;height:40px">
          <option value="one">One</option>
          <option value="two">Two</option>
        </select>
        <script>
          const select = document.querySelector("#select");
          select.addEventListener("mousedown", event => {
            event.preventDefault();
            select.focus();
          });
        </script>
      `);
      enablePageHumanization(page, { idle: false });
      const target = page.locator("#select");
      const intendedTarget = await target.elementHandle();
      assert.ok(intendedTarget);
      target.elementHandle = async () => intendedTarget;

      const originalTargetPress = intendedTarget.press.bind(intendedTarget);
      let calls = 0;
      const entered = deferred();
      const released = deferred();
      const settled = deferred();
      const delayEnter = async (key: string, operation: () => Promise<void>): Promise<void> => {
        if (key !== "Enter") {
          await operation();
          return;
        }
        calls += 1;
        entered.resolve();
        await released.promise;
        try {
          await operation();
        } finally {
          settled.resolve();
        }
      };
      intendedTarget.press = async (key, options) =>
        delayEnter(key, () => originalTargetPress(key, options));

      const operation = humanizedSelectOption(page, target, "two", { timeout: 5_000 });
      await requireProtocolEntry(entered.promise, operation);
      await assert.rejects(operation, /timeout|timed out/i);
      assert.equal(calls, 1);
      await page.setContent(`
        <button id="other">Unrelated action</button>
        <script>
          window.events = [];
          for (const type of ["keydown", "keypress", "beforeinput", "input", "keyup", "click"])
            document.addEventListener(type, event => window.events.push({ type: event.type, repeat: event.repeat ?? false }), true);
        </script>
      `);
      await page.locator("#other").focus();
      released.resolve();
      await settled.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.deepEqual(
        await page.evaluate(() => (window as unknown as { events: unknown[] }).events),
        [],
      );
      assert.deepEqual(unhandled, []);

      await page.evaluate(() => ((window as unknown as { events: unknown[] }).events = []));
      await page.keyboard.press("Enter");
      assert.deepEqual(
        await page.evaluate(
          () => (window as unknown as { events: Array<{ type: string; repeat: boolean }> }).events,
        ),
        [
          { type: "keydown", repeat: false },
          { type: "keypress", repeat: false },
          { type: "click", repeat: false },
          { type: "keyup", repeat: false },
        ],
      );
    } finally {
      process.off("unhandledRejection", recordUnhandled);
      ghostPathOverride.create = undefined;
    }
  });
});

test("humanized selects do not release held keys onto controls focused by keydown handlers", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <select id="select" style="position:absolute;left:400px;top:280px;width:140px;height:40px">
        <option value="one">One</option>
        <option value="two">Two</option>
      </select>
      <button id="other">Unrelated action</button>
      <script>
        window.selectKeydowns = 0;
        window.otherKeyups = 0;
        window.otherClicks = 0;
        const select = document.querySelector("select");
        const other = document.querySelector("#other");
        select.addEventListener("mousedown", event => {
          event.preventDefault();
          select.focus();
        });
        select.addEventListener("keydown", event => {
          window.selectKeydowns += 1;
          event.preventDefault();
          setTimeout(() => other.focus(), 0);
        });
        other.addEventListener("keyup", () => {
          window.otherKeyups += 1;
          other.click();
        });
        other.addEventListener("click", () => window.otherClicks += 1);
      </script>
    `);
    enablePageHumanization(page, { idle: false });

    let operationError: unknown;
    try {
      await humanizedSelectOption(page, page.locator("select"), "two", { timeout: 5_000 });
    } catch (error) {
      operationError = error;
    }

    const result = await page.evaluate(() => ({
      value: (document.querySelector("select") as HTMLSelectElement).value,
      selectKeydowns: (window as unknown as { selectKeydowns: number }).selectKeydowns,
      otherKeyups: (window as unknown as { otherKeyups: number }).otherKeyups,
      otherClicks: (window as unknown as { otherClicks: number }).otherClicks,
      activeId: (document.activeElement as HTMLElement).id,
    }));
    assert.deepEqual(result, {
      value: "one",
      selectKeydowns: 1,
      otherKeyups: 0,
      otherClicks: 0,
      activeId: "other",
    });
    assert.match(String(operationError), /focus|actionable/);
  });
});

test("a keyboard guard install that settles after timeout is cleaned", async () => {
  await withBrowserPage(async (page) => {
    ghostPathOverride.create = (_start, end) => [end];
    try {
      await page.setContent(`
        <select id="select" style="position:absolute;left:10px;top:10px;width:100px;height:40px">
          <option value="one">One</option><option value="two">Two</option>
        </select>
        <button id="other" style="position:absolute;left:200px;top:10px">Unrelated action</button>
        <script>
          window.otherKeyups = 0;
          window.otherClicks = 0;
          document.querySelector("#other").addEventListener("keyup", () => {
            window.otherKeyups += 1;
            document.querySelector("#other").click();
          });
          document.querySelector("#other").addEventListener("click", () => window.otherClicks += 1);
        </script>

      `);
      enablePageHumanization(page, { idle: false });
      const target = page.locator("#select");
      const intendedTarget = await target.elementHandle();
      assert.ok(intendedTarget);
      const delayedInstall = blockKeyboardGuardInstallAfterBrowserSide(
        intendedTarget,
        ({ key, types }) =>
          key === "Home" && types?.join(",") === "keydown,keypress,keyup,beforeinput",
      );
      target.elementHandle = async () => intendedTarget;

      const operation = humanizedSelectOption(page, target, "two", { timeout: 3_000 });
      await requireProtocolEntry(delayedInstall.entered, operation);
      await assert.rejects(operation, /timeout|timed out/i);
      assert.equal(await keyboardGuardRegistrySize(page), 1);
      await page.locator("#other").focus();
      delayedInstall.release();
      await delayedInstall.settled;

      await vi.waitFor(async () => assert.equal(await keyboardGuardRegistrySize(page), 0));
      assert.deepEqual(
        await page.evaluate(() => ({
          keyups: (window as unknown as { otherKeyups: number }).otherKeyups,
          clicks: (window as unknown as { otherClicks: number }).otherClicks,
        })),
        { keyups: 0, clicks: 0 },
      );

      await page.keyboard.press("Home");
      assert.deepEqual(
        await page.evaluate(() => ({
          keyups: (window as unknown as { otherKeyups: number }).otherKeyups,
          clicks: (window as unknown as { otherClicks: number }).otherClicks,
        })),
        { keyups: 1, clicks: 1 },
      );
    } finally {
      ghostPathOverride.create = undefined;
    }
  });
});

test("humanized select missing-option errors do not expose the requested value", async () => {
  await withBrowserPage(async (page) => {
    const requested = "missing-private-option-4f8a";
    await page.setContent(`
      <select style="position:absolute;left:400px;top:280px;width:100px;height:40px">
        <option value="available">Available</option>
      </select>
    `);
    enablePageHumanization(page, { idle: false });

    await assert.rejects(
      humanizedSelectOption(page, page.locator("select"), requested, { timeout: 5_000 }),
      (error: Error) => {
        assert.match(error.message, /option value was not found/);
        assert.ok(!error.message.includes(requested));
        return true;
      },
    );
  });
});

test("humanized select mismatch errors do not expose requested or actual values", async () => {
  await withBrowserPage(async (page) => {
    const requested = "requested-private-option-c813";
    const actual = "actual-private-option-2d6b";
    await page.setContent(`
      <select style="position:absolute;left:400px;top:280px;width:100px;height:40px">
        <option value="${actual}">Actual</option>
        <option value="${requested}">Requested</option>
      </select>
    `);
    enablePageHumanization(page, { idle: false });
    const target = page.locator("select");
    const intendedTarget = await target.elementHandle();
    assert.ok(intendedTarget);
    intendedTarget.inputValue = async () => actual;
    target.elementHandle = async () => intendedTarget;

    await assert.rejects(
      humanizedSelectOption(page, target, requested, { timeout: 5_000 }),
      (error: Error) => {
        assert.match(error.message, /option value could not be selected/);
        assert.ok(!error.message.includes(requested));
        assert.ok(!error.message.includes(actual));
        return true;
      },
    );
  });
});

test("humanized select timeout covers movement and key cadence", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <select style="position:absolute;left:400px;top:280px;width:100px;height:40px">
        ${Array.from({ length: 30 }, (_, index) => `<option value="${index}">${index}</option>`).join("")}
      </select>
    `);
    enablePageHumanization(page, { idle: false });
    const started = Date.now();

    await assert.rejects(
      humanizedSelectOption(page, page.locator("select"), "29", { timeout: 3_000 }),
      /timeout|timed out/i,
    );

    assert.ok(Date.now() - started < 3_600, "select exceeded its single timeout deadline");
  });
});

test.each([
  {
    name: "mouse move",
    html: '<button style="position:absolute;left:700px;top:420px;width:140px;height:60px">Continue</button>',
    delayProtocol: (page: import("playwright").Page) => delayMethod(page.mouse, "move", 7_000),
    operate: (page: import("playwright").Page) =>
      humanizedClick(page, page.getByRole("button", { name: "Continue" }), { timeout: 5_000 }),
  },
  {
    name: "mouse wheel",
    html: '<body style="height:2600px"><button style="position:absolute;left:360px;top:2200px;width:160px;height:50px">Continue</button></body>',
    delayProtocol: (page: import("playwright").Page) => delayMethod(page.mouse, "wheel", 7_000),
    operate: (page: import("playwright").Page) =>
      humanizedClick(page, page.getByRole("button", { name: "Continue" }), { timeout: 5_000 }),
  },
  {
    name: "mouse down",
    html: '<button style="position:absolute;left:440px;top:290px;width:80px;height:40px">Continue</button>',
    delayProtocol: (page: import("playwright").Page) => delayMethod(page.mouse, "down", 7_000),
    operate: (page: import("playwright").Page) =>
      humanizedClick(page, page.getByRole("button", { name: "Continue" }), { timeout: 5_000 }),
  },
  {
    name: "mouse up",
    html: '<button style="position:absolute;left:440px;top:290px;width:80px;height:40px">Continue</button>',
    delayProtocol: (page: import("playwright").Page) => delayMethod(page.mouse, "up", 7_000),
    operate: (page: import("playwright").Page) =>
      humanizedClick(page, page.getByRole("button", { name: "Continue" }), { timeout: 5_000 }),
  },
])(
  "humanized operation deadline bounds $name protocol calls",
  async ({ html, delayProtocol, operate }) => {
    await withBrowserPage(async (page) => {
      ghostPathOverride.create = (_start, end) => [end];
      try {
        await page.setContent(html);
        enablePageHumanization(page, { idle: false });
        const protocol = delayProtocol(page);
        const started = Date.now();
        const operation = operate(page);

        await requireProtocolEntry(protocol.entered, operation);
        await assert.rejects(operation, /timeout|timed out/i);

        assert.ok(protocol.calls() > 0, "the delayed protocol method was not reached");
        assert.ok(Date.now() - started < 6_000, "protocol call exceeded the public deadline");
      } finally {
        ghostPathOverride.create = undefined;
      }
    });
  },
);

test.each([
  {
    name: "mouse",
    html: '<button style="position:absolute;left:440px;top:290px;width:80px;height:40px">Continue</button>',
    delayDown: (page: import("playwright").Page, recordUp: () => void) => {
      const delayed = blockMethodUntilReleased(page.mouse, "down");
      const upCalled = deferred();
      page.mouse.up = async () => {
        recordUp();
        upCalled.resolve();
        throw new Error("late mouse-up cleanup failure");
      };
      return { ...delayed, upCalled: upCalled.promise };
    },
    operate: (page: import("playwright").Page) =>
      humanizedClick(page, page.getByRole("button", { name: "Continue" }), { timeout: 5_000 }),
  },
])(
  "a timed-out $name down still cleans up without an unhandled rejection",
  async ({ html, delayDown, operate }) => {
    await withBrowserPage(async (page) => {
      const unhandled: unknown[] = [];
      const recordUnhandled = (error: unknown): void => {
        unhandled.push(error);
      };
      process.on("unhandledRejection", recordUnhandled);
      try {
        await page.setContent(html);
        enablePageHumanization(page, { idle: false });
        let upCalls = 0;
        const delayed = delayDown(page, () => {
          upCalls += 1;
        });
        const operation = operate(page);

        await requireProtocolEntry(delayed.entered, operation);
        await assert.rejects(operation, /timeout|timed out/i);
        delayed.release();
        await delayed.settled;
        await delayed.upCalled;

        assert.equal(upCalls, 1);
        assert.deepEqual(unhandled, []);
      } finally {
        process.off("unhandledRejection", recordUnhandled);
      }
    });
  },
);

test("saved click steps use the humanized executor without changing the step", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <button style="position:absolute;left:700px;top:420px">Continue</button>
      <script>
        window.moves = [];
        document.addEventListener("mousemove", event => window.moves.push({ x: event.clientX, y: event.clientY }));
      </script>
    `);
    enablePageHumanization(page, { idle: false });
    const step = {
      id: "continue",
      type: "click" as const,
      safety: "browser-local" as const,
      locator: { strategy: "role" as const, role: "button", name: "Continue" },
    };

    assert.deepEqual(await executeStep(page, step, 3_000), { ok: true });
    assert.deepEqual(step, {
      id: "continue",
      type: "click",
      safety: "browser-local",
      locator: { strategy: "role", role: "button", name: "Continue" },
    });
    const moves = await page.evaluate(
      () => (window as unknown as { moves: Array<{ x: number; y: number }> }).moves,
    );
    assert.ok(moves.length > 3, "expected executeStep to use the humanized mouse path");
    assert.ok(
      moves[0]!.x < 600,
      `executeStep trial-moved before approach: ${JSON.stringify(moves)}`,
    );
  });
});

test("idle movement never replaces the result of the operation being awaited", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent("<main style='width:100vw;height:100vh'></main>");
    enablePageHumanization(page, {
      idleInitialDelayMs: [0, 0],
      idleIntervalMs: [0, 0],
      idleMoveChance: 1,
      idleWheelChance: 0,
      idleMaxDistance: 40,
    });

    const result = await withHumanizedWait(page, async () => {
      await page.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "operation-result";
    });

    assert.equal(result, "operation-result");
  });
});

test("idle movement never replaces the error from the operation being awaited", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent("<main style='width:100vw;height:100vh'></main>");
    enablePageHumanization(page, {
      idleInitialDelayMs: [0, 0],
      idleIntervalMs: [0, 0],
      idleMoveChance: 1,
      idleWheelChance: 0,
      idleMaxDistance: 40,
    });
    page.mouse.move = async () => {
      throw new Error("idle transport failure");
    };
    const operationError = new Error("operation failure");

    await assert.rejects(
      withHumanizedWait(page, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw operationError;
      }),
      (error) => error === operationError,
    );
  });
});

test("navigation succeeds when idle movement aborts during a page change", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent('<main style="width:100vw;height:100vh"></main>');
    await page.route("https://example.test/target", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({ status: 200, contentType: "text/html", body: "<main>Done</main>" });
    });
    enablePageHumanization(page, {
      idleInitialDelayMs: [0, 0],
      idleIntervalMs: [10, 10],
      idleMoveChance: 1,
      idleWheelChance: 0,
      idleMaxDistance: 40,
    });

    const outcome = await executeStep(
      page,
      {
        id: "navigate",
        type: "navigate",
        url: "https://example.test/target",
        safety: "browser-local",
      },
      1_000,
    );

    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(await page.locator("main").textContent(), "Done");
  });
});

test("condition waits activate idle movement without changing condition polling", async () => {
  await withBrowserPage(async (page) => {
    await page.setContent(`
      <main style="width:100vw;height:100vh"></main>
      <script>
        window.moves = 0;
        document.addEventListener("mousemove", () => window.moves += 1);
        setTimeout(() => document.querySelector("main").dataset.ready = "yes", 600);
      </script>
    `);
    enablePageHumanization(page, {
      idleInitialDelayMs: [0, 0],
      idleIntervalMs: [10, 10],
      idleMoveChance: 1,
      idleWheelChance: 0,
      idleMaxDistance: 40,
    });
    await page.mouse.move(450, 300);
    await page.evaluate(() => ((window as unknown as { moves: number }).moves = 0));

    await waitCondition(
      page,
      {
        kind: "attribute",
        locator: { strategy: "css", selector: "main" },
        name: "data-ready",
        value: "yes",
      },
      {},
      2_000,
    );

    assert.ok(
      (await page.evaluate(() => (window as unknown as { moves: number }).moves)) > 1,
      "expected idle movement while polling",
    );
  });
});

test("cursor speed and route duration are deterministically about twenty percent faster", () => {
  assert.deepEqual(HUMANIZED_CURSOR_TIMING.moveSpeed, [500, 750]);

  for (const distance of [0, 400, 2_000]) {
    const oldDuration = Math.min(850, 180 + distance * 0.45);
    const newDuration = humanizedCursorRouteDurationMs(distance);
    assert.equal(newDuration, Math.round(oldDuration * 0.8));
    assert.ok(newDuration > 0, "cursor travel must remain paced rather than teleporting");
  }
});

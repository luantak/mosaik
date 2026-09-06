import assert from "node:assert/strict";
import { chromium, type ElementHandle, type Page } from "playwright";

export async function withBrowserPage(run: (page: Page) => Promise<void>): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await run(page);
  } finally {
    await browser.close();
  }
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function delayMethod<T extends object, K extends keyof T>(
  target: T,
  method: K,
  milliseconds: number,
): { calls: () => number; entered: Promise<void> } {
  const original = target[method];
  assert.equal(typeof original, "function");
  let calls = 0;
  const entered = deferred();
  target[method] = (async (...args: unknown[]) => {
    calls += 1;
    entered.resolve();
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return (original as (...values: unknown[]) => unknown).apply(target, args);
  }) as T[K];
  return { calls: () => calls, entered: entered.promise };
}

export async function requireProtocolEntry(
  entered: Promise<void>,
  operation: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    entered,
    operation.then(
      () => {
        throw new Error("operation completed before the delayed protocol method was entered");
      },
      (error: unknown) => {
        throw new Error(
          `operation failed before the delayed protocol method was entered: ${String(error)}`,
        );
      },
    ),
  ]);
}

export function blockMethodUntilReleased<T extends object, K extends keyof T>(
  target: T,
  method: K,
): { calls: () => number; entered: Promise<void>; release: () => void; settled: Promise<void> } {
  const original = target[method];
  assert.equal(typeof original, "function");
  let calls = 0;
  const entered = deferred();
  const released = deferred();
  const settled = deferred();
  target[method] = (async (...args: unknown[]) => {
    calls += 1;
    entered.resolve();
    await released.promise;
    try {
      return await (original as (...values: unknown[]) => unknown).apply(target, args);
    } finally {
      settled.resolve();
    }
  }) as T[K];
  return {
    calls: () => calls,
    entered: entered.promise,
    release: released.resolve,
    settled: settled.promise,
  };
}

export function blockKeyboardGuardInstallAfterBrowserSide(
  handle: ElementHandle<HTMLElement | SVGElement>,
  matches: (options: { key?: string; types?: string[] }) => boolean,
): { entered: Promise<void>; release: () => void; settled: Promise<void> } {
  const originalEvaluate = handle.evaluate.bind(handle) as (
    pageFunction: unknown,
    arg?: unknown,
  ) => Promise<unknown>;
  const entered = deferred();
  const released = deferred();
  const settled = deferred();
  handle.evaluate = (async (pageFunction: unknown, arg?: unknown) => {
    const result = await originalEvaluate(pageFunction, arg);
    const options = arg as { token?: unknown; key?: string; types?: string[] } | undefined;
    if (typeof options?.token === "number" && matches(options)) {
      entered.resolve();
      await released.promise;
      settled.resolve();
    }
    return result;
  }) as typeof handle.evaluate;
  return { entered: entered.promise, release: released.resolve, settled: settled.promise };
}

export async function keyboardGuardRegistrySize(page: import("playwright").Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __mosaikKeyboardTargetGuards?: Map<number, unknown>;
        }
      ).__mosaikKeyboardTargetGuards?.size ?? 0,
  );
}

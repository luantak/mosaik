import { setTimeout as sleep } from "node:timers/promises";
import { path as ghostCursorPath } from "ghost-cursor";
import type { ElementHandle, Frame, Locator, Mouse, Page, Request } from "playwright";

interface Point {
  x: number;
  y: number;
}

interface InteractionDeadline {
  expiresAt?: number;
  timeout?: number;
}

interface ClickNavigationMonitor {
  waitForNavigation(): Promise<void>;
  dispose(): void;
}

interface KeyboardTargetGuard {
  dispose(deadline?: InteractionDeadline): Promise<void>;
}

interface ElementEvaluationTarget {
  evaluate<R, Arg>(
    pageFunction: (element: HTMLElement | SVGElement, arg: Arg) => R | Promise<R>,
    arg: Arg,
  ): Promise<R>;
}

export interface HumanizationSettings {
  idle?: boolean;
  idleInitialDelayMs?: readonly [number, number];
  idleIntervalMs?: readonly [number, number];
  idleMoveChance?: number;
  idleMaxDistance?: number;
}

interface HumanizationState {
  position: Point;
  idleOrigin: Point;
  settings: Required<HumanizationSettings>;
  idleDestinations: Point[];
  idleAbort?: AbortController;
  idleTask?: Promise<void>;
}

const humanizedPages = new WeakMap<Page, HumanizationState>();
const pointerPositions = new WeakMap<Page, Point>();
const instrumentedMice = new WeakMap<Mouse, Mouse["move"]>();
const CLICK_NAVIGATION_DETECTION_MS = 250;
let keyboardGuardSequence = 0;

const dispatchedClickErrors = new WeakSet<object>();

export function wasHumanizedClickDispatched(error: unknown): boolean {
  return typeof error === "object" && error !== null && dispatchedClickErrors.has(error);
}

function markHumanizedClickDispatched(error: unknown): object {
  const dispatchedError =
    typeof error === "object" && error !== null ? error : new Error(String(error));
  dispatchedClickErrors.add(dispatchedError);
  return dispatchedError;
}

export function enablePageHumanization(page: Page, settings: HumanizationSettings = {}): void {
  if (humanizedPages.has(page)) return;
  instrumentMousePosition(page);
  const position = pointerPositions.get(page) ?? { x: 0, y: 0 };
  humanizedPages.set(page, {
    position: { ...position },
    idleOrigin: { ...position },
    idleDestinations: [],
    settings: {
      idle: settings.idle ?? true,
      idleInitialDelayMs: settings.idleInitialDelayMs ?? [700, 1_600],
      idleIntervalMs: settings.idleIntervalMs ?? [900, 2_400],
      idleMoveChance: settings.idleMoveChance ?? 0.45,
      idleMaxDistance: settings.idleMaxDistance ?? 80,
    },
  });
}

export async function configurePageHumanization(
  page: Page,
  enabled: boolean,
  settings: HumanizationSettings = {},
): Promise<void> {
  instrumentMousePosition(page);
  if (enabled) {
    enablePageHumanization(page, settings);
    return;
  }
  const state = humanizedPages.get(page);
  if (state === undefined) return;
  humanizedPages.delete(page);
  await stopIdle(state);
}

function instrumentMousePosition(page: Page): void {
  const mouse = page.mouse;
  if (instrumentedMice.has(mouse)) return;
  const originalMove = mouse.move.bind(mouse);
  instrumentedMice.set(mouse, originalMove);
  mouse.move = async (x, y, options) => {
    await originalMove(x, y, options);
    const position = { x, y };
    pointerPositions.set(page, position);
    const state = humanizedPages.get(page);
    if (state !== undefined) state.position = position;
  };
}

export function isPageHumanized(page: Page): boolean {
  return humanizedPages.has(page);
}

export async function humanizedClick(
  page: Page,
  target: Locator,
  options: { timeout?: number } = {},
): Promise<void> {
  const state = humanizedPages.get(page);
  if (state === undefined) {
    await target.click(options);
    return;
  }
  await humanizedClickWithDeadline(page, state, target, createDeadline(options.timeout));
}

async function humanizedClickWithDeadline(
  page: Page,
  state: HumanizationState,
  target: Locator,
  deadline: InteractionDeadline,
): Promise<ElementHandle<HTMLElement | SVGElement>> {
  await stopIdle(state);
  await withHumanizedWait(page, () =>
    target.waitFor({ state: "visible", ...deadlineOptions(deadline) }),
  );
  if (!(await target.isEnabled(deadlineOptions(deadline)))) {
    throw new Error("Humanized click target is not actionable at the pointer");
  }
  await humanizedScrollIntoView(page, target, deadline);
  const intendedTarget = await target.elementHandle(deadlineOptions(deadline));
  if (intendedTarget === null) {
    throw new Error("Humanized click target is not actionable at the pointer");
  }
  const box = await deadlineRace(intendedTarget.boundingBox(), deadline);
  if (box === null) throw new Error("Humanized click target has no visible bounding box");
  const destination = pointInside(box);
  await ensureActionableAt(intendedTarget, destination, deadline);
  await moveMouse(page, state, destination, undefined, undefined, deadline);
  await deadlineDelay(randomInteger(45, 120), deadline);
  await ensureActionableAt(intendedTarget, state.position, deadline);
  remainingTimeout(deadline);
  const navigation = monitorClickNavigation(page, deadline);
  let mouseDown = false;
  const mouseDownTask = page.mouse.down();
  mouseDown = true;
  try {
    try {
      await deadlineRace(mouseDownTask, deadline);
    } catch (error) {
      void mouseDownTask.then(() => page.mouse.up()).catch(() => undefined);
      throw error;
    }
    mouseDown = true;
    try {
      await deadlineDelay(randomInteger(35, 95), deadline);
    } finally {
      await deadlineRace(page.mouse.up(), deadline);
    }
    await navigation.waitForNavigation();
  } catch (error) {
    throw mouseDown ? markHumanizedClickDispatched(error) : error;
  } finally {
    navigation.dispose();
  }
  return intendedTarget;
}

function monitorClickNavigation(page: Page, deadline: InteractionDeadline): ClickNavigationMonitor {
  let navigationStarted = false;
  let resolveStarted!: () => void;
  let resolveCommitted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    resolveCommitted = resolve;
  });
  const markStarted = (): void => {
    navigationStarted = true;
    resolveStarted();
  };
  const onRequest = (request: Request): void => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) markStarted();
  };
  const onFrameNavigated = (frame: Frame): void => {
    if (frame === page.mainFrame()) {
      markStarted();
      resolveCommitted();
    }
  };
  page.on("request", onRequest);
  page.on("framenavigated", onFrameNavigated);

  return {
    async waitForNavigation(): Promise<void> {
      const didStart =
        navigationStarted ||
        (await Promise.race([
          started.then(() => true),
          deadlineDelay(CLICK_NAVIGATION_DETECTION_MS, deadline).then(() => false),
        ]));
      if (!didStart) return;
      await Promise.race([
        committed,
        deadlineDelay(remainingTimeout(deadline) ?? 30_000, deadline),
      ]);
      await page.waitForLoadState("domcontentloaded", deadlineOptions(deadline));
    },
    dispose(): void {
      page.off("request", onRequest);
      page.off("framenavigated", onFrameNavigated);
    },
  };
}

async function ensureActionableAt(
  target: Locator | ElementHandle<HTMLElement | SVGElement>,
  point: Point,
  deadline: InteractionDeadline,
): Promise<void> {
  const actionable = await deadlineRace(
    (target as unknown as ElementEvaluationTarget).evaluate((element, { x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return (
        element.isConnected &&
        !element.matches(":disabled") &&
        element.closest('[aria-disabled="true"]') === null &&
        hit !== null &&
        (hit === element || element.contains(hit))
      );
    }, point),
    deadline,
  );
  if (!actionable) throw new Error("Humanized click target is not actionable at the pointer");
}

async function ensureTargetEnabled(target: Locator, deadline: InteractionDeadline): Promise<void> {
  const enabled =
    (await target.isEnabled(deadlineOptions(deadline))) &&
    (await target.evaluate(
      (element) =>
        element.isConnected &&
        !element.matches(":disabled") &&
        element.closest('[aria-disabled="true"]') === null,
      undefined,
      deadlineOptions(deadline),
    ));
  if (!enabled) throw new Error("Humanized target is disabled or not actionable");
}

async function humanizedScrollIntoView(
  page: Page,
  target: Locator,
  deadline?: InteractionDeadline,
): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) return;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rect = await target.evaluate(
      (element) => {
        const value = element.getBoundingClientRect();
        return { top: value.top, right: value.right, bottom: value.bottom, left: value.left };
      },
      undefined,
      deadlineOptions(deadline),
    );
    if (
      rect.top >= 12 &&
      rect.right <= viewport.width - 12 &&
      rect.bottom <= viewport.height - 12 &&
      rect.left >= 12
    )
      return;
    const deltaX =
      rect.left < 12 || rect.right > viewport.width - 12
        ? rect.left - viewport.width * randomNumber(0.35, 0.58)
        : 0;
    const deltaY =
      rect.top < 12 || rect.bottom > viewport.height - 12
        ? rect.top - viewport.height * randomNumber(0.35, 0.58)
        : 0;
    await humanizedWheel(page, deltaX, deltaY, deadline);
    await deadlineDelay(randomInteger(45, 100), deadline);
  }
}

async function humanizedWheel(
  page: Page,
  deltaX: number,
  deltaY: number,
  deadline?: InteractionDeadline,
): Promise<void> {
  const distance = Math.hypot(deltaX, deltaY);
  const steps = Math.min(28, Math.max(8, Math.ceil(distance / 75)));
  const weights = Array.from({ length: steps }, (_, index) =>
    Math.sin((Math.PI * (index + 1)) / (steps + 1)),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  for (const weight of weights) {
    remainingTimeout(deadline);
    await deadlineRace(
      page.mouse.wheel((deltaX * weight) / totalWeight, (deltaY * weight) / totalWeight),
      deadline,
    );
    await deadlineDelay(randomInteger(10, 24), deadline);
  }
}

export async function humanizedFill(
  page: Page,
  target: Locator,
  value: string,
  options: { timeout?: number } = {},
): Promise<void> {
  const state = humanizedPages.get(page);
  if (state === undefined) {
    await target.fill(value, options);
    return;
  }

  const deadline = createDeadline(options.timeout);
  const intendedTarget = await humanizedClickWithDeadline(page, state, target, deadline);
  await deadlineDelay(randomInteger(40, 100), deadline);
  await ensureFillKeyboardTarget(intendedTarget, state.position, deadline);
  remainingTimeout(deadline);
  await pressFillKey(
    page,
    intendedTarget,
    state.position,
    "ControlOrMeta+A",
    ["Control", "Meta", "a", "A"],
    deadline,
  );
  await deadlineDelay(randomInteger(35, 80), deadline);
  await ensureFillKeyboardTarget(intendedTarget, state.position, deadline);
  remainingTimeout(deadline);
  await pressFillKey(page, intendedTarget, state.position, "Backspace", ["Backspace"], deadline);
  for (const [index, character] of [...value].entries()) {
    const delay = index % 2 === 0 ? randomInteger(35, 60) : randomInteger(75, 110);
    await deadlineDelay(delay, deadline);
    await ensureFillKeyboardTarget(intendedTarget, state.position, deadline);
    remainingTimeout(deadline);
    const guard = await installKeyboardTargetGuard(
      page,
      intendedTarget,
      { key: character, text: character, types: ["keydown", "keypress", "keyup", "beforeinput"] },
      deadline,
    );
    try {
      await ensureFillKeyboardTarget(intendedTarget, state.position, deadline);
    } catch (error) {
      await guard.dispose(deadline).catch(() => undefined);
      throw error;
    }
    const typeTask = Promise.resolve().then(() => intendedTarget.type(character));
    try {
      await deadlineRace(typeTask, deadline);
    } catch (error) {
      void typeTask.finally(() => guard.dispose()).catch(() => undefined);
      throw error;
    }
    await guard.dispose(deadline).catch(() => undefined);
    await ensureTargetFocused(intendedTarget, deadline);
    if (/[,.;:!?]/.test(character) && Math.random() < 0.35) {
      await deadlineDelay(randomInteger(120, 300), deadline);
    }
  }
  const actual = await deadlineRace(
    intendedTarget.evaluate((element) =>
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.value
        : element.textContent,
    ),
    deadline,
  );
  if (actual !== value) {
    throw new Error("Humanized fill value did not match the intended control");
  }
}

async function pressFillKey(
  page: Page,
  target: ElementHandle<HTMLElement | SVGElement>,
  point: Point,
  key: string,
  guardedKeys: string[],
  deadline: InteractionDeadline,
): Promise<void> {
  const guard = await installKeyboardTargetGuard(
    page,
    target,
    { keys: guardedKeys, types: ["keydown", "keypress", "keyup", "beforeinput"] },
    deadline,
  );
  try {
    await ensureFillKeyboardTarget(target, point, deadline);
  } catch (error) {
    await guard.dispose(deadline).catch(() => undefined);
    throw error;
  }
  const pressTask = Promise.resolve().then(() => target.press(key));
  try {
    await deadlineRace(pressTask, deadline);
  } catch (error) {
    void pressTask.finally(() => guard.dispose()).catch(() => undefined);
    throw error;
  }
  try {
    await ensureFillKeyboardTarget(target, point, deadline);
  } finally {
    await guard.dispose(deadline).catch(() => undefined);
  }
}

async function ensureFillKeyboardTarget(
  target: ElementHandle<HTMLElement | SVGElement>,
  point: Point,
  deadline?: InteractionDeadline,
): Promise<void> {
  const failure =
    "Humanized fill target lost focus or became disabled, non-editable, invisible, or not actionable";
  try {
    const enabledAndEditable =
      (await deadlineRace(target.isEnabled(), deadline)) &&
      (await deadlineRace(target.isEditable(), deadline));
    const focusedVisibleAndActionable =
      enabledAndEditable &&
      (await deadlineRace(
        target.evaluate((element, { x, y }) => {
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(x, y);
          return (
            element.isConnected &&
            element === document.activeElement &&
            !element.matches(":disabled") &&
            !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
              ? element.readOnly
              : false) &&
            element.closest('[aria-disabled="true"]') === null &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            bounds.width > 0 &&
            bounds.height > 0 &&
            hit !== null &&
            (hit === element || element.contains(hit))
          );
        }, point),
        deadline,
      ));
    if (!focusedVisibleAndActionable) throw new Error(failure);
  } catch (error) {
    if (
      error instanceof Error &&
      /^Humanized interaction timed out after \d+ms$/.test(error.message)
    ) {
      throw error;
    }
    throw new Error(failure);
  }
}

async function ensureTargetFocused(
  target: ElementHandle<HTMLElement | SVGElement>,
  deadline?: InteractionDeadline,
): Promise<void> {
  if (
    !(await deadlineRace(
      target.evaluate((element) => element === document.activeElement),
      deadline,
    ))
  ) {
    throw new Error("Humanized fill target lost focus during typing");
  }
}

export async function humanizedSelectOption(
  page: Page,
  target: Locator,
  value: string,
  options: { timeout?: number } = {},
): Promise<string[]> {
  const state = humanizedPages.get(page);
  if (state === undefined) return target.selectOption(value, options);

  const deadline = createDeadline(options.timeout);
  await stopIdle(state);
  await withHumanizedWait(page, () =>
    target.waitFor({ state: "visible", ...deadlineOptions(deadline) }),
  );
  await ensureTargetEnabled(target, deadline);
  await humanizedScrollIntoView(page, target, deadline);
  await withHumanizedWait(page, () => target.hover({ ...deadlineOptions(deadline), trial: true }));
  const intendedTarget = await target.elementHandle(deadlineOptions(deadline));
  if (intendedTarget === null) {
    throw new Error("Humanized select target is disabled or not actionable");
  }
  const box = await deadlineRace(intendedTarget.boundingBox(), deadline);
  if (box === null) throw new Error("Humanized select target has no visible bounding box");
  await moveMouse(page, state, pointInside(box), undefined, undefined, deadline);
  await deadlineDelay(randomInteger(70, 180), deadline);
  await ensureSelectEnabled(intendedTarget, deadline);
  await ensureActionableAt(intendedTarget, state.position, deadline);
  remainingTimeout(deadline);
  const mouseDownTask = page.mouse.down();
  try {
    await deadlineRace(mouseDownTask, deadline);
  } catch (error) {
    void mouseDownTask.then(() => page.mouse.up()).catch(() => undefined);
    throw error;
  }
  try {
    await deadlineDelay(randomInteger(35, 95), deadline);
  } finally {
    await deadlineRace(page.mouse.up(), deadline);
  }
  await deadlineDelay(randomInteger(70, 160), deadline);
  await ensureSelectKeyboardTarget(intendedTarget, deadline);

  const optionIndex = await deadlineRace(
    intendedTarget.evaluate((element, desired) => {
      const select = element as HTMLSelectElement;
      const enabled = [...select.options].filter(
        (option) =>
          !option.disabled && !(option.parentElement as HTMLOptGroupElement | null)?.disabled,
      );
      return enabled.findIndex((option) => option.value === desired);
    }, value),
    deadline,
  );
  if (optionIndex < 0) {
    await pressSelectKey(page, intendedTarget, "Escape", deadline);
    throw new Error("Select option value was not found");
  }
  await pressSelectKey(page, intendedTarget, "Home", deadline);
  for (let index = 0; index < optionIndex; index += 1)
    await pressSelectKey(page, intendedTarget, "ArrowDown", deadline);
  await pressSelectKey(page, intendedTarget, "Enter", deadline);
  if ((await deadlineRace(intendedTarget.inputValue(), deadline)) !== value) {
    throw new Error("Select option value could not be selected");
  }
  return [value];
}

async function pressSelectKey(
  page: Page,
  target: ElementHandle<HTMLElement | SVGElement>,
  key: string,
  deadline: InteractionDeadline,
): Promise<void> {
  const guard = await installKeyboardTargetGuard(
    page,
    target,
    { key, types: ["keydown", "keypress", "keyup", "beforeinput"] },
    deadline,
  );
  try {
    await ensureSelectKeyboardTarget(target, deadline);
  } catch (error) {
    await guard.dispose(deadline).catch(() => undefined);
    throw error;
  }

  remainingTimeout(deadline);
  const pressTask = Promise.resolve().then(() =>
    target.press(key, { delay: randomInteger(30, 80) }),
  );
  try {
    await deadlineRace(pressTask, deadline);
  } catch (error) {
    void pressTask.finally(() => guard.dispose()).catch(() => undefined);
    throw error;
  }

  try {
    await ensureSelectKeyboardTarget(target, deadline);
    await deadlineDelay(randomInteger(45, 120), deadline);
  } finally {
    await guard.dispose(deadline).catch(() => undefined);
  }
}

async function ensureSelectKeyboardTarget(
  target: ElementHandle<HTMLElement | SVGElement>,
  deadline?: InteractionDeadline,
): Promise<void> {
  const failure = "Humanized select target lost focus or became disabled or not actionable";
  try {
    const focusedAndActionable = await deadlineRace(
      target.evaluate((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          element instanceof HTMLSelectElement &&
          element.isConnected &&
          element === document.activeElement &&
          !element.matches(":disabled") &&
          element.closest('[aria-disabled="true"]') === null &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      }),
      deadline,
    );
    if (!focusedAndActionable || !(await deadlineRace(target.isEnabled(), deadline))) {
      throw new Error(failure);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /^Humanized interaction timed out after \d+ms$/.test(error.message)
    ) {
      throw error;
    }
    throw new Error(failure);
  }
}

async function ensureSelectEnabled(
  target: ElementHandle<HTMLElement | SVGElement>,
  deadline?: InteractionDeadline,
): Promise<void> {
  const failure = "Humanized select target is disabled or not actionable";
  try {
    const connectedAndEnabled = await deadlineRace(
      target.evaluate(
        (element) =>
          element instanceof HTMLSelectElement &&
          element.isConnected &&
          !element.matches(":disabled") &&
          element.closest('[aria-disabled="true"]') === null,
      ),
      deadline,
    );
    if (!connectedAndEnabled || !(await deadlineRace(target.isEnabled(), deadline))) {
      throw new Error(failure);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /^Humanized interaction timed out after \d+ms$/.test(error.message)
    ) {
      throw error;
    }
    throw new Error(failure);
  }
}

async function installKeyboardTargetGuard(
  page: Page,
  target: Locator | ElementHandle<HTMLElement | SVGElement>,
  options: {
    key?: string;
    keys?: string[];
    text?: string;
    types: Array<"keydown" | "keypress" | "keyup" | "beforeinput">;
  },
  deadline?: InteractionDeadline,
): Promise<KeyboardTargetGuard> {
  const token = ++keyboardGuardSequence;
  const installation = (target as unknown as ElementEvaluationTarget).evaluate(
    (element, { token, key, keys, text, types }) => {
      type GuardEventType = "keydown" | "keypress" | "keyup" | "beforeinput";
      type GuardRegistry = Map<number, { listener: EventListener; types: GuardEventType[] }>;
      const global = globalThis as typeof globalThis & {
        __mosaikKeyboardTargetGuards?: GuardRegistry;
      };
      const registry = (global.__mosaikKeyboardTargetGuards ??= new Map());
      const listener: EventListener = (event) => {
        const eventTarget = event.target;
        if (
          eventTarget === element ||
          (eventTarget instanceof Node && element.contains(eventTarget))
        )
          return;
        if (event instanceof KeyboardEvent) {
          if (keys !== undefined && !keys.includes(event.key)) return;
          if (key !== undefined && event.key !== key) return;
        }
        if (event instanceof InputEvent && text !== undefined && event.data !== text) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      registry.set(token, { listener, types });
      for (const type of types) document.addEventListener(type, listener, true);
    },
    { token, ...options },
  );
  try {
    await deadlineRace(installation, deadline);
  } catch (error) {
    void installation.finally(() => cleanupKeyboardTargetGuard(page, token)).catch(() => undefined);
    throw error;
  }

  return {
    async dispose(disposeDeadline?: InteractionDeadline): Promise<void> {
      await deadlineRace(cleanupKeyboardTargetGuard(page, token), disposeDeadline);
    },
  };
}

function cleanupKeyboardTargetGuard(page: Page, token: number): Promise<void> {
  return page.evaluate((guardToken) => {
    type GuardEventType = "keydown" | "keypress" | "keyup" | "beforeinput";
    type GuardRegistry = Map<number, { listener: EventListener; types: GuardEventType[] }>;
    const global = globalThis as typeof globalThis & {
      __mosaikKeyboardTargetGuards?: GuardRegistry;
    };
    const guard = global.__mosaikKeyboardTargetGuards?.get(guardToken);
    if (guard === undefined) return;
    for (const type of guard.types) document.removeEventListener(type, guard.listener, true);
    global.__mosaikKeyboardTargetGuards?.delete(guardToken);
  }, token);
}

export async function withHumanizedWait<T>(page: Page, operation: () => Promise<T>): Promise<T> {
  const state = humanizedPages.get(page);
  if (state === undefined || !state.settings.idle) return operation();
  await stopIdle(state);
  state.idleOrigin = { ...state.position };
  state.idleDestinations = await collectNeutralIdlePoints(page, state);
  const controller = new AbortController();
  state.idleAbort = controller;
  state.idleTask = runIdleLoop(page, state, controller.signal);
  try {
    return await operation();
  } finally {
    await stopIdle(state);
  }
}

async function moveMouse(
  page: Page,
  state: HumanizationState,
  destination: Point,
  signal?: AbortSignal,
  idleSafety?: { origin: Point; maxDistance: number },
  deadline?: InteractionDeadline,
): Promise<void> {
  const generated = ghostCursorPath(state.position, destination, {
    moveSpeed: randomNumber(400, 600),
  }) as Point[];
  const route = generated;
  if (
    idleSafety !== undefined &&
    !(await isNeutralIdleRoute(page, routeCheckpoints(state.position, route), idleSafety, signal))
  )
    return;
  const distance = Math.hypot(destination.x - state.position.x, destination.y - state.position.y);
  const stepDelayMs = Math.max(
    2,
    Math.round(Math.min(850, 180 + distance * 0.45) / Math.max(1, route.length)),
  );
  for (const point of route) {
    if (signal?.aborted) return;
    await deadlineDelay(stepDelayMs, deadline, signal);
    if (
      idleSafety !== undefined &&
      !(await isNeutralIdleRoute(
        page,
        routeCheckpoints(state.position, [point]),
        idleSafety,
        signal,
      ))
    )
      return;
    if (idleSafety === undefined) {
      await deadlineRace(page.mouse.move(point.x, point.y), deadline, signal);
    } else {
      await page.mouse.move(point.x, point.y);
    }
    if (signal?.aborted) return;
    state.position = { x: point.x, y: point.y };
    pointerPositions.set(page, state.position);
  }
}

async function runIdleLoop(
  page: Page,
  state: HumanizationState,
  signal: AbortSignal,
): Promise<void> {
  try {
    await abortableDelay(randomRange(state.settings.idleInitialDelayMs), signal);
    while (!signal.aborted) {
      if (Math.random() < state.settings.idleMoveChance) {
        const destination = neutralIdlePoint(state);
        if (destination !== undefined)
          await moveMouse(page, state, destination, signal, {
            origin: state.idleOrigin,
            maxDistance: state.settings.idleMaxDistance,
          });
      }
      await abortableDelay(randomRange(state.settings.idleIntervalMs), signal);
    }
  } catch {
    // Idle motion is best-effort and must not change the awaited operation's outcome.
  }
}

function routeCheckpoints(start: Point, route: Point[]): Point[] {
  const checkpoints: Point[] = [];
  let previous = start;
  for (const point of route) {
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / 4),
    );
    for (let step = 1; step <= steps; step += 1) {
      checkpoints.push({
        x: previous.x + ((point.x - previous.x) * step) / steps,
        y: previous.y + ((point.y - previous.y) * step) / steps,
      });
    }
    previous = point;
  }
  return checkpoints;
}

async function isNeutralIdleRoute(
  page: Page,
  points: Point[],
  safety: { origin: Point; maxDistance: number },
  signal?: AbortSignal,
): Promise<boolean> {
  return deadlineRace(
    page.evaluate(
      ({ points, origin, maxDistance }) =>
        points.every(({ x, y }) => {
          if (
            x < 8 ||
            y < 8 ||
            x > window.innerWidth - 8 ||
            y > window.innerHeight - 8 ||
            Math.hypot(x - origin.x, y - origin.y) > maxDistance
          )
            return false;
          const element = document.elementFromPoint(x, y);
          return (
            element !== null &&
            !element.closest(
              'a, button, input, select, textarea, [role="button"], [role="link"], [tabindex], [contenteditable], [onclick], [onmouseenter], [onmouseover]',
            )
          );
        }),
      { points, ...safety },
    ),
    undefined,
    signal,
  ).catch(() => false);
}

async function stopIdle(state: HumanizationState): Promise<void> {
  const controller = state.idleAbort;
  const task = state.idleTask;
  delete state.idleAbort;
  delete state.idleTask;
  controller?.abort();
  await task?.catch(() => undefined);
}

async function collectNeutralIdlePoints(page: Page, state: HumanizationState): Promise<Point[]> {
  const viewport = page.viewportSize();
  if (viewport === null) return [];
  const candidates = Array.from({ length: 16 }, () => {
    const angle = randomNumber(0, Math.PI * 2);
    const distance = randomNumber(12, state.settings.idleMaxDistance);
    return {
      x: clamp(state.position.x + Math.cos(angle) * distance, 8, viewport.width - 8),
      y: clamp(state.position.y + Math.sin(angle) * distance, 8, viewport.height - 8),
    };
  });
  return page
    .evaluate(
      (points) =>
        points.filter(({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          return !element?.closest(
            'a, button, input, select, textarea, [role="button"], [role="link"], [tabindex]',
          );
        }),
      candidates,
    )
    .catch(() => []);
}

function neutralIdlePoint(state: HumanizationState): Point | undefined {
  const nearby = state.idleDestinations.filter(
    (candidate) =>
      Math.hypot(candidate.x - state.position.x, candidate.y - state.position.y) <=
      state.settings.idleMaxDistance,
  );
  if (nearby.length === 0) return undefined;
  return nearby[randomInteger(0, nearby.length - 1)];
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await sleep(milliseconds, undefined, signal === undefined ? undefined : { signal });
}

function createDeadline(timeout?: number): InteractionDeadline {
  return timeout === undefined
    ? {}
    : { expiresAt: Date.now() + Math.max(0, timeout), timeout: Math.max(0, timeout) };
}

function remainingTimeout(deadline?: InteractionDeadline): number | undefined {
  if (deadline?.expiresAt === undefined) return undefined;
  const remaining = deadline.expiresAt - Date.now();
  if (remaining <= 0) {
    throw new Error(`Humanized interaction timed out after ${deadline.timeout}ms`);
  }
  return remaining;
}

function deadlineOptions(deadline?: InteractionDeadline): { timeout?: number } {
  const timeout = remainingTimeout(deadline);
  return timeout === undefined ? {} : { timeout };
}

async function deadlineRace<T>(
  operation: Promise<T>,
  deadline?: InteractionDeadline,
  signal?: AbortSignal,
): Promise<T> {
  void operation.catch(() => undefined);
  const remaining = remainingTimeout(deadline);
  if (remaining === undefined && signal === undefined) return operation;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    if (remaining !== undefined) {
      timer = setTimeout(
        () => reject(new Error(`Humanized interaction timed out after ${deadline?.timeout}ms`)),
        remaining,
      );
    }
    if (signal !== undefined) {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
  }
}

async function deadlineDelay(
  milliseconds: number,
  deadline?: InteractionDeadline,
  signal?: AbortSignal,
): Promise<void> {
  const remaining = remainingTimeout(deadline);
  if (remaining === undefined) {
    await abortableDelay(milliseconds, signal);
    return;
  }
  await abortableDelay(Math.min(milliseconds, remaining), signal);
  if (milliseconds >= remaining) remainingTimeout(deadline);
}

function pointInside(box: { x: number; y: number; width: number; height: number }): Point {
  const horizontalInset = Math.min(box.width * 0.2, 12);
  const verticalInset = Math.min(box.height * 0.2, 8);
  return {
    x: randomNumber(box.x + horizontalInset, box.x + box.width - horizontalInset),
    y: randomNumber(box.y + verticalInset, box.y + box.height - verticalInset),
  };
}

function randomRange(range: readonly [number, number]): number {
  return randomInteger(range[0], range[1]);
}

function randomNumber(min: number, max: number): number {
  return min + Math.random() * Math.max(0, max - min);
}

function randomInteger(min: number, max: number): number {
  return Math.round(randomNumber(min, max));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

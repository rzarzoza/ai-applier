import type { Locator } from "playwright";

/**
 * How fast the app works a form, like a quick human typist: each range is [min, max] milliseconds, and every wait picks
 * a random value in it. The one place these delays are set.
 */
export interface Pace {
  /** Between two typed characters. */
  keyMs: readonly [number, number];
  /** Before each field (after scrolling it into view). */
  fieldMs: readonly [number, number];
  /** Before picking an option, ticking a box, clicking a control or attaching a file. */
  actionMs: readonly [number, number];
}

export const HUMAN_PACE: Pace = { keyMs: [10, 35], fieldMs: [150, 400], actionMs: [80, 200] };
export const NO_PACE: Pace = { keyMs: [0, 0], fieldMs: [0, 0], actionMs: [0, 0] };

/** The pace for the environment: none with `AI_APPLIER_PACE=off` (the test suite sets it), else human. */
export function paceFromEnv(env: Record<string, string | undefined> = process.env): Pace {
  return env.AI_APPLIER_PACE === "off" ? NO_PACE : HUMAN_PACE;
}

let override: Pace | null = null;

/** Sets the pace for everything that follows (null: back to the environment's). */
export function setPace(p: Pace | null): void {
  override = p;
}

export function currentPace(): Pace {
  return override ?? paceFromEnv();
}

/** A random whole number of milliseconds in the range. */
export function pick([min, max]: readonly [number, number]): number {
  return max <= min ? min : Math.round(min + Math.random() * (max - min));
}

const wait = (range: readonly [number, number]) => {
  const ms = pick(range);
  return ms > 0 ? new Promise<void>(r => setTimeout(r, ms)) : Promise.resolve();
};

/** Before a field: scrolls it into view, then pauses. */
export async function beforeField(el: Locator): Promise<void> {
  await el.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
  await wait(currentPace().fieldMs);
}

/** The short pause before acting on a control (select, click, tick, attach). */
export function beforeAction(): Promise<void> {
  return wait(currentPace().actionMs);
}

/**
 * Types `text` into the element with the keyboard, one character at a time at the current pace, after focusing it and
 * clearing what it held. Newlines are inserted as text (never an Enter key press, which could submit a form).
 */
export async function typeText(el: Locator, text: string): Promise<void> {
  await el.click({ timeout: 5_000 }).catch(() => el.focus({ timeout: 5_000 }));
  if (await el.inputValue({ timeout: 2_000 }).catch(() => "")) await el.fill("");
  await typeKeys(el, text);
}

/** Types `text` at the current pace into whatever has focus on the element's page (the caller focused `el`). */
export async function typeKeys(el: Locator, text: string): Promise<void> {
  const keyboard = el.page().keyboard;
  const { keyMs } = currentPace();
  if (keyMs[1] <= 0) {
    for (const [i, part] of text.split("\n").entries()) {
      if (i > 0) await keyboard.insertText("\n");
      if (part) await keyboard.type(part);
    }
    return;
  }
  for (const ch of text) {
    if (ch === "\n") await keyboard.insertText("\n");
    else await keyboard.type(ch);
    await wait(keyMs);
  }
}

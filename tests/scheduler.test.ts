import { expect, test } from "vitest";
import { SerialQueue } from "../src/scheduler.js";

test("SerialQueue never overlaps tasks and keeps going after a failure", async () => {
  const q = new SerialQueue();
  let running = 0, maxRunning = 0;
  const task = (v: number, fail = false) => q.run(async () => {
    running++; maxRunning = Math.max(maxRunning, running);
    await new Promise(r => setTimeout(r, 5));
    running--;
    if (fail) throw new Error("boom");
    return v;
  });
  const results = await Promise.allSettled([task(1), task(2, true), task(3)]);
  expect(maxRunning).toBe(1);
  expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect((results[2] as PromiseFulfilledResult<number>).value).toBe(3);
});

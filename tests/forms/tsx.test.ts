import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

// The app runs under tsx (esbuild keepNames), which injects `__name` helpers that break serialized in-page code.
test("extract + fill work when run under tsx", async () => {
  const { stdout } = await promisify(execFile)("pnpm", ["exec", "tsx", "tests/forms/scripts/tsx-smoke.ts"], { cwd: process.cwd(), timeout: 60000 });
  expect(stdout).toMatch(/OK 13/);
}, 90000);

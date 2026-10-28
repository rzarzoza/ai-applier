import { expect, test, vi } from "vitest";
import { getSecret, setSecret } from "../src/secrets.js";

test("getSecret reads the generic password and trims the newline", async () => {
  const run = vi.fn().mockResolvedValue("sk-test\n");
  expect(await getSecret("anthropic-api-key", run)).toBe("sk-test");
  expect(run).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-s", "ai-applier", "-a", "anthropic-api-key", "-w"]);
});

test("getSecret returns null when security exits 44 (item not found)", async () => {
  const run = vi.fn().mockRejectedValue(Object.assign(new Error("not found"), { code: 44 }));
  expect(await getSecret("x", run)).toBeNull();
});

test("getSecret rethrows other failures", async () => {
  const run = vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { code: 1 }));
  await expect(getSecret("x", run)).rejects.toThrow("boom");
});

test("setSecret sends the command on stdin, never in argv, with quoting escaped", async () => {
  const run = vi.fn().mockResolvedValue("");
  await setSecret("anthropic-api-key", 'sk-"new"\\x', run);
  const [file, args, input] = run.mock.calls[0]!;
  expect(file).toBe("/usr/bin/security");
  expect(args).toEqual(["-i"]);
  expect(JSON.stringify(args)).not.toContain("sk-");
  expect(input).toBe('add-generic-password -U -s ai-applier -a "anthropic-api-key" -w "sk-\\"new\\"\\\\x"\n');
});

test("setSecret rejects values with line breaks without running anything", async () => {
  const run = vi.fn();
  await expect(setSecret("x", "a\nb", run)).rejects.toThrow("line breaks");
  expect(run).not.toHaveBeenCalled();
});

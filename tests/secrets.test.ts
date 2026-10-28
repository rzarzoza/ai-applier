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

/** A fake Keychain: `-i` writes land in `stored`, reads return it. */
const fakeKeychain = (readBack: (stored: string | null) => string | null = v => v) => {
  let stored: string | null = null;
  return vi.fn(async (_f: string, args: string[], input?: string) => {
    if (args[0] === "-i") { stored = /-w "((?:[^"\\]|\\.)*)"/.exec(input!)![1]!.replace(/\\(.)/g, "$1"); return ""; }
    const v = readBack(stored);
    if (v === null) throw Object.assign(new Error("nf"), { code: 44 });
    return v + "\n";
  });
};

test("setSecret resolves when the read-back matches and throws without echoing the value when it does not", async () => {
  await expect(setSecret("k", "sk-abc", fakeKeychain())).resolves.toBeUndefined();
  const err = await setSecret("k", "sk-abc", fakeKeychain(() => "other")).catch((e: Error) => e);
  expect((err as Error).message).toBe("Keychain write could not be verified");
  await expect(setSecret("k", "sk-abc", fakeKeychain(() => null))).rejects.toThrow("could not be verified");
});

test("setSecret sends the command on stdin, never in argv, with quoting escaped", async () => {
  const run = fakeKeychain();
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

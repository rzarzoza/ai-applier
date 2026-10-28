import { execFile } from "node:child_process";

const SECURITY = "/usr/bin/security";
const SERVICE = "ai-applier";
/** `security` exit code for "The specified item could not be found in the keychain". */
const NOT_FOUND = 44;

/** Runs a command and resolves with stdout. Injectable so tests never touch the real Keychain. */
export type Runner = (file: string, args: string[]) => Promise<string>;

const run: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

export async function getSecret(name: string, runner: Runner = run): Promise<string | null> {
  try {
    const out = await runner(SECURITY, ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
    return out.replace(/\r?\n$/, "") || null;
  } catch (e) {
    if ((e as { code?: unknown }).code === NOT_FOUND) return null;
    throw e;
  }
}

export async function setSecret(name: string, value: string, runner: Runner = run): Promise<void> {
  await runner(SECURITY, ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-w", value]);
}

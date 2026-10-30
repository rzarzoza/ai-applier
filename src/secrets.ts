import { execFile } from "node:child_process";

const SECURITY = "/usr/bin/security";
const SERVICE = "ai-applier";
/** `security` exit code for "The specified item could not be found in the keychain". */
const NOT_FOUND = 44;

/** Runs a command and resolves with stdout. Injectable so tests never touch the real Keychain. */
export type Runner = (file: string, args: string[], input?: string) => Promise<string>;

const run: Runner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    if (input !== undefined) child.stdin?.end(input);
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

/**
 * Stores the secret without putting it in the process arguments (visible to other users via `ps`, and
 * echoed in execFile errors): the command goes to `security -i` on stdin instead.
 */
export async function setSecret(name: string, value: string, runner: Runner = run): Promise<void> {
  if (/[\r\n\0]/.test(value) || /[\r\n\0\s]/.test(name)) throw new Error("The secret cannot contain line breaks");
  const quote = (v: string) => `"${v.replace(/[\\"]/g, "\\$&")}"`;
  const command = `add-generic-password -U -s ${SERVICE} -a ${quote(name)} -w ${quote(value)}\n`;
  await runner(SECURITY, ["-i"], command);
  // `security -i` can exit 0 when its command failed, so confirm the value really is stored.
  if ((await getSecret(name, runner)) !== value) throw new Error("Keychain write could not be verified");
}

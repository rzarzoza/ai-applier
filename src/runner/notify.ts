import { execFile } from "node:child_process";

const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The AppleScript that shows a macOS notification with this title and message. */
export function notificationScript(title: string, message: string): string {
  return `display notification ${appleString(message)} with title ${appleString(title)}`;
}

/** Shows a macOS notification via osascript. Never throws: a failed notification is ignored. */
export function macNotify(title: string, message: string): Promise<void> {
  return new Promise(resolve => {
    try {
      execFile("osascript", ["-e", notificationScript(title, message)], { timeout: 10_000 }, () => resolve());
    } catch {
      resolve();
    }
  });
}

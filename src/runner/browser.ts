import { chromium, type Page } from "playwright";
import { paths } from "../paths.js";

export interface BrowserProvider {
  open(opts: { headless: boolean }): Promise<{ page: Page; close(): Promise<void> }>;
}

/** Chromium with a persistent profile at `BROWSER_PROFILE_DIR`, so cookies and portal sessions survive between runs. */
export const persistentChromium: BrowserProvider = {
  async open({ headless }) {
    const context = await chromium.launchPersistentContext(paths.browserProfile, { headless });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      return { page, close: () => context.close() };
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }
  },
};

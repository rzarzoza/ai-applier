/**
 * Usage: pnpm tsx scripts/capture-fixture.ts <url> <outfile>
 * Opens the posting with its ATS handler (headed; HEADLESS=1 for headless) and saves an inert snapshot:
 * stylesheets (including CSS-in-JS rules) are inlined into one <style>, scripts and iframes are dropped,
 * so the fixture renders like the live form without running or fetching anything.
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { inPage } from "../src/forms/in-page.js";
import { detectAts } from "../src/ats/registry.js";

const [url, outfile] = process.argv.slice(2);
if (!url || !outfile) {
  console.error("usage: capture-fixture.ts <url> <outfile>");
  process.exit(2);
}
const handler = detectAts(url);
if (!handler) throw new Error(`No ATS handler matches ${url}`);

const browser = await chromium.launch({ headless: process.env.HEADLESS === "1" });
try {
  const page = await browser.newPage();
  const opened = await handler.open(page, url);
  if (!opened.ok) throw new Error(`open failed: ${opened.reason} ${opened.detail ?? ""}`);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  const root = await handler.root(page);

  const sheets = (await root.evaluate(inPage(() => Array.from(document.styleSheets).map(s => {
    try { return { css: Array.from(s.cssRules).map(r => r.cssText).join("\n") }; }
    catch { return { href: s.href ?? "" }; }
  })))) as { css?: string; href?: string }[];
  const css: string[] = [];
  for (const s of sheets) {
    if (s.css !== undefined) css.push(s.css);
    else if (s.href) css.push(await (await page.request.get(s.href)).text());
  }
  await root.evaluate(inPage((allCss: string) => {
    document.querySelectorAll('script, iframe, style, link[rel~="stylesheet"], link[rel~="preload"], link[rel~="modulepreload"]').forEach(e => e.remove());
    const style = document.createElement("style");
    style.textContent = allCss;
    document.head.appendChild(style);
  }), css.join("\n"));
  writeFileSync(outfile, `<!-- captured from ${root.url()} -->\n${await root.content()}`);
  console.log(`wrote ${outfile}`);
} finally {
  await browser.close();
}

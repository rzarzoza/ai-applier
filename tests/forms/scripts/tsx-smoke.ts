import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { extractFields } from "../../../src/forms/extract.js";
import { fillField, readBack } from "../../../src/forms/fill.js";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(readFileSync(new URL("../../fixtures/forms/basic.html", import.meta.url), "utf8"));
  const fields = await extractFields(page);
  const check = async (label: string, answer: Parameters<typeof fillField>[2], expected: unknown) => {
    const f = fields.find(x => x.label === label)!;
    await fillField(page, f, answer);
    const got = await readBack(page, f);
    if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(got)}`);
  };
  await check("First Name", { type: "text", text: "Ada" }, "Ada");
  await check("Degree", { type: "option", option: "Master's" }, "Master's");
  await check("Are you authorized to work in the US?", { type: "option", option: "Yes" }, "Yes");
  await check("Which languages?", { type: "options", options: ["Spanish"] }, ["Spanish"]);
  await check("Department", { type: "option", option: "Design" }, "Design");
  console.log(`OK ${fields.length}`);
} finally {
  await browser.close();
}

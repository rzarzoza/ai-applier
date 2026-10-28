import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { getProfile } from "../../src/profile/profile.js";
import { setDataDir } from "../../src/paths.js";
import { form, setupApp } from "./helpers.js";

const pdf = (bytes = "%PDF-1.4 fake") => new File([bytes], "r.pdf", { type: "application/pdf" });
const upload = (file: File) => { const fd = new FormData(); fd.set("resume", file); return { method: "POST", body: fd }; };

test("GET /profile groups fields and renders booleans as Yes/No selects", async () => {
  const { app } = setupApp();
  const html = await (await app.request("/profile")).text();
  for (const g of ["Contact", "Education", "Work authorization", "Demographics"]) expect(html).toContain(g);
  expect(html).toContain('name="usCitizen"');
  expect(html).toContain("<option");
});

test("POST /profile round-trips booleans, strings and employers", async () => {
  const { db, app } = setupApp();
  const res = await app.request("/profile", form({
    firstName: "Ada", email: "a@b.co", phone: "", usCitizen: "no", willingToRelocate: "yes", requiresSponsorship: "", employers: "Acme, Globex",
  }));
  expect(res.status).toBe(303);
  const p = getProfile(db);
  expect(p).toMatchObject({ firstName: "Ada", email: "a@b.co", phone: null, usCitizen: false, willingToRelocate: true, requiresSponsorship: null });
  expect(p.employers).toEqual(["Acme", "Globex"]);
});

test("POST /profile does not clobber resume fields", async () => {
  const { db, app } = setupApp();
  await app.request("/profile", form({ firstName: "Ada" }));
  expect(getProfile(db).resumeText).toBeNull();
});

test("resume upload runs importResume and reports the filled count", async () => {
  setDataDir(mkdtempSync(path.join(tmpdir(), "aia-")));
  const { app, llm, db } = setupApp();
  llm.on("resume", () => ({ firstName: "Ada", lastName: "L", resumeText: "text" }) as z.infer<z.ZodAny>);
  const html = await (await app.request("/profile/resume", upload(pdf()))).text();
  expect(html).toContain("Filled 2 fields from your resume");
  expect(getProfile(db).firstName).toBe("Ada");
});

test("resume upload rejects non-PDF content and wrong types", async () => {
  setDataDir(mkdtempSync(path.join(tmpdir(), "aia-")));
  const { app, llm } = setupApp();
  expect(await (await app.request("/profile/resume", upload(pdf("not a pdf")))).text()).toContain("PDF");
  expect(await (await app.request("/profile/resume", upload(new File(["%PDF-1"], "r.txt", { type: "text/plain" })))).text()).toContain("PDF");
  expect(llm.calls).toHaveLength(0);
});

test("resume upload rejects files over 10 MB", async () => {
  const { app, llm } = setupApp();
  const big = pdf("%PDF-" + "x".repeat(10 * 1024 * 1024));
  expect(await (await app.request("/profile/resume", upload(big))).text()).toContain("10 MB");
  expect(llm.calls).toHaveLength(0);
});

test("resume upload shows an error card when the LLM fails, not a 500", async () => {
  setDataDir(mkdtempSync(path.join(tmpdir(), "aia-")));
  const { app } = setupApp(); // no handler registered -> structured() throws
  const res = await app.request("/profile/resume", upload(pdf()));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("read the resume");
});

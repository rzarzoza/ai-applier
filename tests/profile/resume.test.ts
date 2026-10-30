import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { openDb } from "../../src/db/db.js";
import { paths } from "../../src/paths.js";
import { saveProfile } from "../../src/profile/profile.js";
import { importResume } from "../../src/profile/resume.js";
import { FakeLlm } from "../helpers/fake-llm.js";

test("importResume fills empty fields only and never touches EEO fields", async () => {
  const db = openDb(":memory:");
  saveProfile(db, { email: "keep@x.com" });
  const llm = new FakeLlm().on("resume", () => ({ email: "other@x.com", firstName: "Luis", school: "UT", resumeText: "..." }));
  const p = await importResume(db, llm, "tests/fixtures/resume-sample.pdf");
  expect(p).toMatchObject({ email: "keep@x.com", firstName: "Luis", school: "UT", gender: "Male", resumeText: "...", resumePath: paths.resume });
  expect(existsSync(paths.resume)).toBe(true);
  expect(llm.calls[0].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "document" })]));
});

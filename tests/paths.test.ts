import { expect, test } from "vitest";
import path from "node:path";
import { paths, setDataDir } from "../src/paths.js";

test("paths follow setDataDir", () => {
  const prev = paths.dataDir;
  setDataDir("/x/y");
  expect(paths.db).toBe(path.join("/x/y", "app.db"));
  expect(paths.records).toBe(path.join("/x/y", "records"));
  expect(paths.browserProfile).toBe(path.join("/x/y", "browser-profile"));
  expect(paths.resume).toBe(path.join("/x/y", "resume.pdf"));
  setDataDir(prev);
});

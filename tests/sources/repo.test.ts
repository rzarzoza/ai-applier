import { expect, test } from "vitest";
import { openDb } from "../../src/db/db.js";
import { addSource, listSources, markPolled, setSourceEnabled } from "../../src/sources/repo.js";

test("sources are seeded and can be added, toggled and marked polled", () => {
  const db = openDb(":memory:");
  const seeded = listSources(db);
  expect(seeded.map(s => s.id)).toEqual(["simplify-summer2027"]);
  expect(seeded[0]).toMatchObject({ kind: "simplify-json", enabled: true, etag: null, lastPolledAt: null });
  addSource(db, { id: "r", kind: "readme-table", url: "https://x.test/R.md", enabled: true });
  setSourceEnabled(db, "r", false);
  markPolled(db, "r", '"e"', new Date("2026-10-27T00:00:00Z"));
  const r = listSources(db).find(s => s.id === "r")!;
  expect(r).toMatchObject({ enabled: false, etag: '"e"', lastPolledAt: "2026-10-27T00:00:00.000Z" });
});

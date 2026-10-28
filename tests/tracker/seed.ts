import type { Db } from "../../src/db/db.js";
import { setStatus, upsertPosting } from "../../src/jobs/repo.js";
import type { JobStatus } from "../../src/jobs/types.js";

let n = 0;
/** Inserts a job and forces the columns the tracker reads. */
export function seedJob(db: Db, o: {
  status: JobStatus; company?: string; title?: string; url?: string; location?: string | null;
  at?: string; resume?: string | null; cover?: string | null;
}): string {
  const id = upsertPosting(db, {
    sourceId: "t", listingId: String(++n), company: o.company ?? "Acme", title: o.title ?? "Software Engineer Intern",
    locations: ["NYC"], category: "Software", terms: [], degrees: [], sponsorship: null,
    url: o.url ?? `https://job-boards.greenhouse.io/acme/jobs/${n}`, datePosted: new Date(), active: true,
  }).job.id;
  setStatus(db, id, o.status);
  const at = o.at ?? "2026-10-28T12:00:00.000Z";
  db.prepare("UPDATE jobs SET submitted_at = ?, updated_at = ?, chosen_location = ?, resume_used = ?, cover_letter_used = ? WHERE id = ?")
    .run(o.status === "submitted" ? at : null, at, o.location === undefined ? "NYC" : o.location, o.resume ?? null, o.cover ?? null, id);
  return id;
}

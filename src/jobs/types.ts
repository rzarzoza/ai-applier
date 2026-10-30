export type JobStatus =
  | "new" | "skipped" | "duplicate-role" | "queued" | "filling" | "needs-you" | "ready-to-review"
  | "submitted" | "failed" | "closed" | "unsupported" | "applied-manually";

export interface Job {
  id: string;
  sourceId: string;
  listingId: string;
  company: string;
  title: string;
  locations: string[];
  chosenLocation: string | null;
  category: string | null;
  terms: string[];
  url: string;
  urlNorm: string;
  datePosted: Date;
  active: boolean;
  status: JobStatus;
  statusReason: string | null;
  ats: string | null;
  roleKey: string;
  /** The posting's degree requirements; null for jobs stored before they were recorded. */
  degrees: string[] | null;
  attempts: number;
  submittedAt: Date | null;
  updatedAt: Date;
}

export interface Posting {
  sourceId: string;
  listingId: string;
  company: string;
  title: string;
  locations: string[];
  category: string | null;
  terms: string[];
  degrees: string[];
  sponsorship: string | null;
  url: string;
  datePosted: Date;
  active: boolean;
}

export interface SourceConfig {
  id: string;
  kind: "simplify-json" | "readme-table";
  url: string;
  enabled: boolean;
  etag: string | null;
  lastPolledAt: string | null;
}

export type FetchResult =
  | { notModified: true }
  | { notModified: false; etag: string | null; postings: Posting[] };

export interface SourceAdapter {
  fetch(cfg: SourceConfig, fetchFn?: typeof fetch): Promise<FetchResult>;
}

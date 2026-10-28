const SEASON_YEAR = /\b(?:spring|summer|fall|autumn|winter|20\d{2})\b/g;

/** Identifies "the same role" across postings: company + title (no punctuation/season/year) + sorted terms. */
export function roleKey(company: string, title: string, terms: string[]): string {
  const cleanTitle = title
    .toLowerCase()
    .replace(SEASON_YEAR, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sortedTerms = terms.map(t => t.toLowerCase().trim()).sort();
  return `${company.toLowerCase().trim()}|${cleanTitle}|${sortedTerms.join(",")}`;
}

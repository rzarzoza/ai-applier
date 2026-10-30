const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR".split(" "),
);
const CA_PROVINCES = new Set("AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" "));

const US_STATE_NAMES = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida",
  "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
  "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska",
  "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas",
  "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
  "puerto rico",
]);
const CA_PROVINCE_NAMES = new Set([
  "alberta", "british columbia", "manitoba", "new brunswick", "newfoundland and labrador", "nova scotia",
  "ontario", "prince edward island", "quebec", "saskatchewan",
]);

const COUNTRY_ALIASES: Record<string, string> = {
  usa: "USA", us: "USA", "u.s.": "USA", "u.s.a.": "USA", "united states": "USA", "united states of america": "USA",
  canada: "Canada",
  uk: "UK", "u.k.": "UK", "united kingdom": "UK", england: "UK", scotland: "UK", wales: "UK", "northern ireland": "UK",
  india: "India", germany: "Germany", france: "France", ireland: "Ireland", netherlands: "Netherlands",
  spain: "Spain", italy: "Italy", switzerland: "Switzerland", sweden: "Sweden", poland: "Poland",
  israel: "Israel", singapore: "Singapore", japan: "Japan", china: "China", australia: "Australia",
  brazil: "Brazil", mexico: "Mexico", "south korea": "South Korea", taiwan: "Taiwan", portugal: "Portugal",
  "new zealand": "New Zealand", "united arab emirates": "UAE", uae: "UAE", "hong kong": "Hong Kong",
};

const CITY_ALIASES: Record<string, string> = {
  nyc: "USA", sf: "USA", la: "USA", "south sf": "USA", "bay area": "USA", "san francisco bay area": "USA",
};

export function inferCountry(location: string): string {
  let loc = location.trim();
  const remote = /^remote\s+(?:in|-|–|,)\s*(.+)$/i.exec(loc);
  if (remote) loc = remote[1]!.trim();

  const parts = loc.split(",").map((s) => s.trim()).filter(Boolean);
  const last = parts.at(-1)?.toLowerCase() ?? "";
  if (COUNTRY_ALIASES[last]) return COUNTRY_ALIASES[last];

  if (US_STATE_NAMES.has(last)) return "USA";
  if (CA_PROVINCE_NAMES.has(last)) return "Canada";

  const code = parts.at(-1)?.toUpperCase() ?? "";
  if (parts.length > 1 || remote) {
    if (US_STATES.has(code)) return "USA";
    if (CA_PROVINCES.has(code)) return "Canada";
  }
  const whole = loc.toLowerCase();
  if (CITY_ALIASES[whole]) return CITY_ALIASES[whole];
  if (CITY_ALIASES[last]) return CITY_ALIASES[last];
  return "Unknown";
}

# AI Applier — Core (Plan 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local app that polls the SimplifyJobs list, filters postings, fills and submits Greenhouse, Lever, and Ashby applications from one resume + a learning answer bank, and shows a question-first inbox dashboard.

**Architecture:** One Node process with three parts sharing one SQLite database: a **poller** (sources → filters → job queue), a **runner** (Playwright Chromium drives one application at a time, using an answer **resolver** backed by profile, answer bank, and Claude), and a **web dashboard** (Hono server-rendered JSX + htmx on localhost). Each application system is an `AtsHandler` plugged into a registry. Plans 2 and 3 add Workday/accounts/email and Oracle/SmartRecruiters/generic handlers to that registry.

**Tech Stack:** Node 24 (ESM), TypeScript, pnpm, `tsx`, Vitest, `node:sqlite` (built-in, no native deps), Playwright (Chromium), `@anthropic-ai/sdk` + `zod`, Hono + `@hono/node-server` + hono/jsx, htmx (CDN).

**Spec:** `docs/superpowers/specs/2026-10-27-ai-applier-design.md`

**Scope of this plan:** spec §4.1–4.6, 4.8–4.10, and the Greenhouse/Lever/Ashby part of §4.6. **Not here:** Workday, accounts, IMAP email codes (§4.7, Plan 2); Oracle, SmartRecruiters, generic handler (Plan 3). Jobs on those systems get status `unsupported` and are requeued when their plan lands.

## Global Constraints

- Runs locally on macOS, single user. Web server binds `127.0.0.1` only, port `4310`.
- All data lives under `DATA_DIR` = `process.env.AI_APPLIER_DATA ?? "./data"` (git-ignored).
- Claude model: `claude-opus-5-5` for every call. Structured output via `client.beta.messages.parse` + `zodOutputFormat`. Always send `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`. Check `stop_reason === "refusal"` before reading output. Set `output_config.effort` explicitly on every call (default on this model is `medium`).
- Default source URL: `https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json`. Use only entries with `active && is_visible`. Never use `simplify.jobs` links.
- Default filters: categories `["Software", "Software Engineering"]`; exclude country `Canada`; posted within `14` days; location mode `any`.
- Poll every `30` minutes by default. One job at a time.
- Auto-submit is the default (`reviewMode: "off"`). Never submit when: a required field is blank, an answer is an unapproved AI draft, or a CAPTCHA/verification step is unresolved.
- Optional fields that can't be answered confidently are left blank. Factual questions are never AI-guessed.
- Required legal/consent boxes are ticked and typed-name signatures use the profile's full name. Optional SMS/marketing/"talent community" opt-ins are never ticked.
- CAPTCHA / verification code: keep the browser open, send a macOS notification, wait up to `10` minutes, then set the job to `needs-you`.
- Secrets (Anthropic API key) go in the macOS Keychain under service `ai-applier`, never in the DB or files.
- Every job ends in a visible status. Every failure stores a reason and a screenshot.
- Tests never submit a real application. Live tests run only with `LIVE=1` and stop before clicking submit.

## Review Focus

1. **Location strings that aren't "City, ST"** — `NYC`, `SF`, `LA`, `Remote in USA`, `United States`, `Kanata, Ottawa, ON, Canada`, `London, UK`. A reasonable person expects NYC to count as USA and Kanata to count as Canada. → Task 3 tests.
2. **Option lists that don't contain the profile value verbatim** — profile says `Hispanic or Latino`, form offers `Yes` / `No` for "Are you Hispanic/Latino?"; profile says US citizen, form offers `U.S. Citizen or permanent resident`. Expected: pick the semantically correct option; if none fits confidently, block as missing — never pick the first option. → Task 8 tests.
3. **Character limits** — an approved 900-character answer into a `maxlength=500` textarea. Expected: a shortened rewrite under the limit, never a mid-word cut. → Task 8 test.
4. **Validation errors after clicking submit** (bad phone format, missing field the extractor didn't see). Expected: status `failed` with the page's error messages, not `submitted`. → Task 13 test.
5. **Source fetch failure** (GitHub 5xx, truncated/malformed JSON). Expected: report the error, change nothing — in particular, don't mark existing jobs `closed`. → Task 4 test.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore
src/
  paths.ts                    DATA_DIR and derived paths
  db/db.ts, db/migrations.ts  openDb + ordered migrations
  settings.ts                 kv store + Settings
  secrets.ts                  macOS Keychain wrapper
  sources/types.ts            Posting, SourceConfig, SourceAdapter
  sources/normalize.ts        normalizeUrl
  sources/simplify.ts         listings.json adapter
  sources/readme-table.ts     README table adapter
  sources/repo.ts             sources table
  sources/poller.ts           pollAll
  filters/country.ts          inferCountry
  filters/filters.ts          FilterRules, evaluateFilters
  jobs/types.ts, jobs/repo.ts, jobs/role-key.ts
  llm/llm.ts                  Llm interface + ClaudeLlm
  profile/profile.ts          Profile schema, defaults, keys, storage
  profile/resume.ts           importResume
  forms/types.ts              FieldSpec, FieldAnswer, JobContext
  forms/extract.ts            extractFields (DOM → FieldSpec[])
  forms/fill.ts               fillField, readBack
  answers/bank.ts             questions, variants, blockers, needs-you, overrides
  answers/inbox.ts            answerQuestion (approve + requeue)
  answers/classify.ts         classifyFields (+ field cache)
  answers/adapt.ts            pickOption, adaptAnswer
  answers/match.ts            matchQuestion
  answers/draft.ts            draftAnswer, reviseDraft, fillTemplate
  answers/resolve.ts          resolveFields
  ats/types.ts, ats/registry.ts, ats/greenhouse.ts, ats/lever.ts, ats/ashby.ts
  runner/runner.ts, runner/records.ts, runner/notify.ts, runner/browser.ts
  web/server.ts, web/layout.tsx, web/pages/{inbox,applications,bank,profile,sources,settings}.tsx
  main.ts
scripts/capture-fixture.ts
tests/ (mirrors src/), tests/helpers/fake-llm.ts, tests/fixtures/{simplify,readme,forms,greenhouse,lever,ashby}/, tests/live/
```

---

### Task 1: Project scaffold, database, settings

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/paths.ts`, `src/db/db.ts`, `src/db/migrations.ts`, `src/settings.ts`
- Modify: `.gitignore` (already has `.superpowers/ node_modules/ .env data/`; add `test-results/`)
- Test: `tests/db.test.ts`, `tests/settings.test.ts`

**Interfaces:**
- Produces:
  - `paths.ts`: `DATA_DIR: string`, `DB_PATH = DATA_DIR/app.db`, `RECORDS_DIR = DATA_DIR/records`, `BROWSER_PROFILE_DIR = DATA_DIR/browser-profile`, `RESUME_PATH = DATA_DIR/resume.pdf`
  - `db.ts`: `type Db = DatabaseSync` (from `node:sqlite`); `openDb(path: string): Db` — enables `foreign_keys`, `journal_mode=WAL` (skip WAL for `:memory:`), runs pending migrations tracked by `PRAGMA user_version`.
  - `migrations.ts`: `export const migrations: string[]` — each later task **appends** its SQL; never edit an earlier entry.
  - `settings.ts`: `getJson<T>(db, key: string, fallback: T): T`, `setJson(db, key: string, value: unknown): void`, `interface Settings { reviewMode: "off" | "all" | "companies"; reviewCompanies: string[]; dailyLimit: number | null; pollMinutes: number; headless: boolean; paused: boolean }`, `DEFAULT_SETTINGS: Settings = { reviewMode: "off", reviewCompanies: [], dailyLimit: null, pollMinutes: 30, headless: false, paused: false }`, `getSettings(db): Settings` (merges stored over defaults), `saveSettings(db, patch: Partial<Settings>): Settings`.

- [ ] **Step 1: Scaffold** — `pnpm init`; set `"type": "module"`; scripts `"dev": "tsx watch src/main.ts"`, `"start": "tsx src/main.ts"`, `"test": "vitest run"`, `"test:live": "LIVE=1 vitest run tests/live"`, `"typecheck": "tsc --noEmit"`. Install deps: `pnpm add @anthropic-ai/sdk zod hono @hono/node-server playwright` and `pnpm add -D typescript tsx vitest @types/node`. Use the `zod` major that `@anthropic-ai/sdk/helpers/zod` declares as its peer. Run `pnpm exec playwright install chromium`. tsconfig: `target ES2023`, `module/moduleResolution NodeNext`, `strict`, `jsx: "react-jsx"`, `jsxImportSource: "hono/jsx"`, `noEmit`. Vitest: `testTimeout: 30000`, exclude `tests/live/**` unless `LIVE=1`.
- [ ] **Step 2: Write failing tests**

```ts
// tests/db.test.ts
test("openDb runs migrations once and records user_version", () => {
  const db = openDb(":memory:");
  const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
  expect(v.user_version).toBe(migrations.length);
  expect(() => db.prepare("SELECT key, value FROM kv").all()).not.toThrow();
});
// tests/settings.test.ts
test("getSettings returns defaults, saveSettings merges", () => {
  const db = openDb(":memory:");
  expect(getSettings(db)).toEqual(DEFAULT_SETTINGS);
  saveSettings(db, { reviewMode: "all", dailyLimit: 20 });
  expect(getSettings(db)).toMatchObject({ reviewMode: "all", dailyLimit: 20, pollMinutes: 30, headless: false });
});
```

- [ ] **Step 3: Run** `pnpm test` → FAIL (modules missing).
- [ ] **Step 4: Implement.** Migration 1: `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`. Each migration runs inside a transaction with `PRAGMA user_version = n`.
- [ ] **Step 5: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: scaffold project, sqlite migrations, settings store"`

---

### Task 2: Sources — listings.json and README-table adapters

**Files:**
- Create: `src/sources/types.ts`, `src/sources/normalize.ts`, `src/sources/simplify.ts`, `src/sources/readme-table.ts`, `src/sources/repo.ts`
- Modify: `src/db/migrations.ts` (append migration)
- Test: `tests/sources/normalize.test.ts`, `tests/sources/simplify.test.ts`, `tests/sources/readme-table.test.ts`
- Fixtures: `tests/fixtures/simplify/listings-sample.json` — ~12 real entries copied from the live file (include: an inactive one, an `is_visible:false` one, a Workday one, a Greenhouse one, a Lever one, an Ashby one, a `Toronto, ON, Canada` one, a multi-location one). `tests/fixtures/readme/simplify-readme-sample.md` — the first ~8 `<tr>` rows of the live README including a `↳` row. `tests/fixtures/readme/pipe-table.md` — a hand-written Markdown pipe table (`| Company | Role | Location | Application/Link | Date Posted |`) with 3 rows.

**Interfaces:**
- Produces:
  - `interface Posting { sourceId: string; listingId: string; company: string; title: string; locations: string[]; category: string | null; terms: string[]; degrees: string[]; sponsorship: string | null; url: string; datePosted: Date; active: boolean }`
  - `interface SourceConfig { id: string; kind: "simplify-json" | "readme-table"; url: string; enabled: boolean; etag: string | null; lastPolledAt: string | null }`
  - `type FetchResult = { notModified: true } | { notModified: false; etag: string | null; postings: Posting[] }`
  - `interface SourceAdapter { fetch(cfg: SourceConfig, fetchFn?: typeof fetch): Promise<FetchResult> }` — sends `If-None-Match` when `cfg.etag`; throws on non-2xx/304 or unparseable body.
  - `normalizeUrl(url: string): string` — lowercase host, drop `utm_*`, `ref`, `source` params, keep everything else (e.g. `gh_jid`), drop trailing `/`.
  - `parseSimplifyListings(json: unknown, sourceId: string): Posting[]`; `simplifyAdapter: SourceAdapter`
  - `parseReadmeTable(text: string, sourceId: string, now: Date): Posting[]`; `readmeTableAdapter: SourceAdapter`
  - `repo.ts`: `listSources(db): SourceConfig[]`, `addSource(db, cfg: Omit<SourceConfig, "etag" | "lastPolledAt">): void`, `setSourceEnabled(db, id, enabled)`, `markPolled(db, id, etag: string | null, at: Date)`.
  - Migration: `sources(id TEXT PK, kind TEXT, url TEXT, enabled INTEGER, etag TEXT, last_polled_at TEXT)` seeded with `{ id: "simplify-summer2027", kind: "simplify-json", url: <default source URL>, enabled: 1 }`.

- [ ] **Step 1: Write failing tests**

```ts
test("normalizeUrl strips tracking params only", () => {
  expect(normalizeUrl("https://Jobs.Lever.co/palantir/abc/apply?utm_source=Simplify&ref=Simplify"))
    .toBe("https://jobs.lever.co/palantir/abc/apply");
  expect(normalizeUrl("https://www.psiquantum.com/apply?gh_jid=7761881003&utm_source=x"))
    .toBe("https://www.psiquantum.com/apply?gh_jid=7761881003");
});
test("parseSimplifyListings keeps active+visible and maps fields", () => {
  const ps = parseSimplifyListings(sampleJson, "simplify-summer2027");
  expect(ps.every(p => p.active)).toBe(true);
  expect(ps.find(p => p.listingId === "<id of inactive entry>")).toBeUndefined();
  const lever = ps.find(p => p.url.includes("lever.co"))!;
  expect(lever.url).not.toContain("simplify.jobs");
  expect(lever.datePosted).toBeInstanceOf(Date);
});
test("parseReadmeTable reads HTML rows, inherits company on ↳, skips simplify links", () => {
  const ps = parseReadmeTable(simplifyReadme, "x", new Date("2026-10-27"));
  expect(ps[0].url).toMatch(/jobs\.lever\.co/);
  const child = ps.find(p => p.title === "Software Engineer Intern" && p.locations.includes("Austin, TX"))!;
  expect(child.company).toBe("Visa");
  expect(ps.some(p => p.url.includes("simplify.jobs"))).toBe(false);
});
test("parseReadmeTable reads markdown pipe tables", () => {
  expect(parseReadmeTable(pipeTable, "x", new Date()).length).toBe(3);
});
test("simplifyAdapter returns notModified on 304 and throws on 500", async () => { /* fake fetchFn */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** README parser: handle both `<tr><td>` HTML rows and `|` pipe rows. Columns found by header names (`Company`, `Role`/`Position`, `Location`, `Application`/`Link`, `Age`/`Date Posted`). `<br>` separates locations. A row's apply link is the first `href` in the application cell that isn't `simplify.jobs`. Rows with no such link are dropped. A row whose apply cell has 🔒 (closed) is dropped. `listingId = normalizeUrl(url)`. Age `"0d"/"5d"/"2mo"` → `now - n`. A month-day date → this year. Otherwise `now`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: source adapters for SimplifyJobs listings.json and README tables`

---

### Task 3: Country inference and filters

**Files:**
- Create: `src/filters/country.ts`, `src/filters/filters.ts`
- Test: `tests/filters/country.test.ts`, `tests/filters/filters.test.ts`

**Interfaces:**
- Consumes: `Posting` (Task 2)
- Produces:
  - `inferCountry(location: string): string` — returns `"USA"`, `"Canada"`, `"UK"`, another country name, or `"Unknown"`.
  - `interface FilterRules { categories: string[]; includeCountries: string[]; excludeCountries: string[]; includeLocations: string[]; excludeLocations: string[]; locationMode: "any" | "all"; postedWithinDays: number | null; excludeCompanies: string[]; titleRequire: string[]; titleBlock: string[]; degrees: string[] }`
  - `DEFAULT_FILTERS: FilterRules` = categories `["Software", "Software Engineering"]`, excludeCountries `["Canada"]`, postedWithinDays `14`, locationMode `"any"`, all other lists `[]`.
  - `type FilterResult = { pass: true; location: string } | { pass: false; reason: string }`
  - `evaluateFilters(p: Posting, rules: FilterRules, now: Date): FilterResult` — `location` is the first location that passes.
  - `getFilters(db): FilterRules` / `saveFilters(db, rules)` (kv key `filters`).

- [ ] **Step 1: Write failing tests**

```ts
test.each([
  ["Seattle, WA", "USA"], ["NYC", "USA"], ["SF", "USA"], ["LA", "USA"], ["Remote in USA", "USA"],
  ["United States", "USA"], ["Washington, DC", "USA"], ["Toronto, ON, Canada", "Canada"],
  ["Kanata, Ottawa, ON, Canada", "Canada"], ["Remote in Canada", "Canada"], ["Vancouver, BC", "Canada"],
  ["London, UK", "UK"], ["Bangalore, India", "India"], ["Remote", "Unknown"], ["Mars Base 1", "Unknown"],
])("inferCountry(%s) = %s", (loc, c) => expect(inferCountry(loc)).toBe(c));

const base: Posting = { sourceId: "s", listingId: "1", company: "Acme", title: "Software Engineer Intern",
  locations: ["Toronto, ON, Canada", "NYC"], category: "Software", terms: ["Summer 2027"], degrees: ["Bachelor's"],
  sponsorship: "Other", url: "https://x", datePosted: new Date("2026-10-20"), active: true };
const now = new Date("2026-10-27");
test("any-mode passes on the first non-excluded location", () =>
  expect(evaluateFilters(base, DEFAULT_FILTERS, now)).toEqual({ pass: true, location: "NYC" }));
test("all-Canada posting is rejected with a reason", () =>
  expect(evaluateFilters({ ...base, locations: ["Toronto, ON, Canada"] }, DEFAULT_FILTERS, now))
    .toEqual({ pass: false, reason: expect.stringContaining("Canada") }));
test("category, age, company, title rules", () => {
  expect(evaluateFilters({ ...base, category: "Hardware" }, DEFAULT_FILTERS, now).pass).toBe(false);
  expect(evaluateFilters({ ...base, datePosted: new Date("2026-10-01") }, DEFAULT_FILTERS, now).pass).toBe(false);
  expect(evaluateFilters(base, { ...DEFAULT_FILTERS, excludeCompanies: ["acme"] }, now).pass).toBe(false);
  expect(evaluateFilters(base, { ...DEFAULT_FILTERS, titleBlock: ["phd"] }, now).pass).toBe(true);
  expect(evaluateFilters({ ...base, title: "PhD Software Intern" }, { ...DEFAULT_FILTERS, titleBlock: ["phd"] }, now).pass).toBe(false);
});
test("includeCountries USA rejects Unknown-only postings", () =>
  expect(evaluateFilters({ ...base, locations: ["Remote"] }, { ...DEFAULT_FILTERS, includeCountries: ["USA"] }, now).pass).toBe(false));
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Order of checks in `inferCountry`:
  1. `Remote in X` → the country of X.
  2. A trailing country name or alias (`Canada`, `UK`/`United Kingdom`/`England`, `USA`/`US`/`United States`, plus ~20 common countries).
  3. A trailing 2-letter code: one of the 50 US states plus `DC`/`PR` → USA; one of the 13 Canadian province codes → Canada.
  4. City aliases `NYC`, `SF`, `LA`, `Bay Area` → USA.
  5. Otherwise `Unknown`.
  
  Company and title matching are case-insensitive substring matches. Category matching is exact. With `locationMode: "all"`, every location must pass.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: country inference and posting filters`

---

### Task 4: Jobs repository and poller

**Files:**
- Create: `src/jobs/types.ts`, `src/jobs/repo.ts`, `src/jobs/role-key.ts`, `src/sources/poller.ts`
- Modify: `src/db/migrations.ts`
- Test: `tests/jobs/repo.test.ts`, `tests/sources/poller.test.ts`

**Interfaces:**
- Consumes: `Posting`, `SourceAdapter`, `listSources/markPolled` (Task 2); `evaluateFilters`, `getFilters` (Task 3)
- Produces:
  - `type JobStatus = "new" | "skipped" | "duplicate-role" | "queued" | "filling" | "needs-you" | "ready-to-review" | "submitted" | "failed" | "closed" | "unsupported" | "applied-manually"`
  - `interface Job { id: string; sourceId: string; listingId: string; company: string; title: string; locations: string[]; chosenLocation: string | null; category: string | null; terms: string[]; url: string; urlNorm: string; datePosted: Date; active: boolean; status: JobStatus; statusReason: string | null; ats: string | null; roleKey: string; attempts: number; submittedAt: Date | null; updatedAt: Date }`
  - `roleKey(company: string, title: string, terms: string[]): string` — lowercased company + title with punctuation and season/year words removed + sorted terms.
  - repo: `upsertPosting(db, p: Posting): { job: Job; isNew: boolean }` (unique on `url_norm` and on `(source_id, listing_id)`), `getJob(db, id)`, `listJobs(db, q: { status?: JobStatus; limit?: number; offset?: number }): Job[]`, `countByStatus(db): Record<JobStatus, number>`, `setStatus(db, id, status: JobStatus, reason?: string | null)`, `setChosenLocation(db, id, loc)`, `setAts(db, id, ats: string)`, `incrementAttempts(db, id)`, `nextQueued(db): Job | null` (newest `date_posted` first), `findLiveRole(db, roleKey, excludeId): Job | null` (status not in skipped/closed/duplicate-role), `submittedSince(db, since: Date): number`, `hasSubmittedToCompany(db, company): boolean`.
  - `pollAll(db, deps: { adapters: Record<SourceConfig["kind"], SourceAdapter>; now: Date; fetchFn?: typeof fetch }): Promise<PollReport[]>` with `interface PollReport { sourceId: string; fetched: number; newJobs: number; queued: number; skipped: number; duplicates: number; closed: number; error?: string }`.
  - Migration: `jobs` table with the fields above (JSON text for arrays), indexes on `status`, `role_key`.

- [ ] **Step 1: Write failing tests**

```ts
test("new passing posting is queued with chosen location; failing one is skipped with reason", async () => {
  const db = openDb(":memory:");
  const report = await pollAll(db, { adapters: fakeAdapters([nyPosting, torontoOnly]), now });
  expect(report[0]).toMatchObject({ newJobs: 2, queued: 1, skipped: 1 });
  expect(listJobs(db, { status: "queued" })[0].chosenLocation).toBe("NYC");
  expect(listJobs(db, { status: "skipped" })[0].statusReason).toContain("Canada");
});
test("same role in another city becomes duplicate-role", async () => { /* two postings, same company/title/terms, different locations → 1 queued, 1 duplicate-role */ });
test("re-polling does not duplicate jobs; posting gone inactive closes a queued job", async () => { /* poll twice; second with active:false → status closed */ });
test("submitted jobs are never re-queued or closed by later polls", async () => {});
test("fetch error is reported and changes nothing", async () => {
  const db = openDb(":memory:");
  await pollAll(db, { adapters: fakeAdapters([nyPosting]), now });
  const r = await pollAll(db, { adapters: throwingAdapters(new Error("HTTP 502")), now });
  expect(r[0].error).toContain("502");
  expect(countByStatus(db).queued).toBe(1);
  expect(countByStatus(db).closed).toBe(0);
});
test("notModified skips processing and keeps etag", async () => {});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** A posting the source no longer lists, or lists as inactive, closes the job only if its status is `queued`, `needs-you`, or `ready-to-review`. A disabled source is skipped. `markPolled` runs only on success.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: job repository and source poller with filters and role de-dup`

---

### Task 5: LLM client

**Files:**
- Create: `src/llm/llm.ts`, `tests/helpers/fake-llm.ts`
- Test: `tests/llm/fake-llm.test.ts`, `tests/live/llm.live.test.ts`

**Interfaces:**
- Produces:
  - `interface StructuredRequest<T> { name: string; schema: z.ZodType<T>; system: string; cachedContext?: string; content: string | Anthropic.Beta.BetaContentBlockParam[]; effort: "low" | "medium" | "high"; maxTokens?: number }`. `name` is a stable label (`"classify"`, `"match"`, …) used by the fake and in logs.
  - `interface Llm { structured<T>(req: StructuredRequest<T>): Promise<T> }`
  - `class ClaudeLlm implements Llm { constructor(opts?: { apiKey?: string }) }`. `system` is sent as text blocks: `system`, then `cachedContext` (if present) with `cache_control: { type: "ephemeral" }`.
  - `class LlmRefusalError extends Error`, `class LlmOutputError extends Error`
  - `FakeLlm implements Llm`: `on<T>(name: string, handler: (req: StructuredRequest<T>) => T): this`; `calls: StructuredRequest<unknown>[]`; throws when no handler is registered for `name`.

- [ ] **Step 1: Write failing tests** — fake: a registered handler's value is returned and recorded in `calls`; an unregistered name throws. Live (`LIVE=1`): `ClaudeLlm` returns `{ ok: true }` for schema `z.object({ ok: z.boolean() })` with prompt "Return ok=true".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with `client.beta.messages.parse({ model: "claude-opus-5-5", max_tokens: req.maxTokens ?? 16000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort, format: zodOutputFormat(schema) }, system, messages: [{ role: "user", content }] })`. Throw `LlmRefusalError` on `stop_reason === "refusal"` and `LlmOutputError` when `parsed_output` is null. If the installed SDK's types reject `fallbacks: "default"`, check the SDK changelog for the field. Don't drop it silently.
- [ ] **Step 4: Run** `pnpm test` → PASS; `LIVE=1 pnpm test:live -t llm` → PASS (needs a key or an `ant auth login` profile).
- [ ] **Step 5: Commit** `feat: Claude structured-output client and fake for tests`

---

### Task 6: Profile and resume import

**Files:**
- Create: `src/profile/profile.ts`, `src/profile/resume.ts`
- Test: `tests/profile/profile.test.ts`, `tests/profile/resume.test.ts`, fixture `tests/fixtures/resume-sample.pdf` (any 1-page PDF)

**Interfaces:**
- Consumes: `Llm` (Task 5), `getJson/setJson` (Task 1), `RESUME_PATH`
- Produces:
  - `ProfileSchema` (zod). Every field is nullable. Fields: `firstName, lastName, preferredName, email, phone, addressLine, city, state, postalCode, country, linkedin, github, website, school, degree, major, gpa, graduationMonth /* "YYYY-MM" */, employers: string[], usCitizen: boolean, workAuthorizedUS: boolean, requiresSponsorship: boolean, willingToRelocate: boolean, earliestStart, gender, sexualOrientation, pronouns, ethnicity, hispanicLatino: boolean, veteranStatus, militarySpouse: boolean, disabilityStatus, relatedToEmployee: boolean, resumePath, resumeText`
  - `type Profile = z.infer<typeof ProfileSchema>`
  - `PROFILE_DEFAULTS: Profile` — all null/[] except the user's stated values: `usCitizen: true, workAuthorizedUS: true, requiresSponsorship: false, gender: "Male", sexualOrientation: "Heterosexual / Straight", pronouns: "He/Him", ethnicity: "Hispanic or Latino", hispanicLatino: true, veteranStatus: "I am not a protected veteran", militarySpouse: false, disabilityStatus: "I do not want to answer"`
  - `type ProfileKey = keyof Profile | "fullName" | "graduationYear" | "location"`. `PROFILE_KEY_DESCRIPTIONS: Record<ProfileKey, string>` is a one-line meaning for each key, used in classifier prompts.
  - `profileValue(p: Profile, key: ProfileKey): string | string[] | boolean | null`. Derived values: `fullName` = first + last; `graduationYear` comes from `graduationMonth`; `location` = `"city, state"`.
  - `getProfile(db): Profile` (stored merged over defaults), `saveProfile(db, patch: Partial<Profile>): Profile`
  - `importResume(db, llm, pdfPath: string): Promise<Profile>`. Copies the file to `RESUME_PATH` and sends it as a base64 `document` block (request name `"resume"`, effort `medium`). The schema is the contact/education/links/employers subset plus `resumeText`. Merge rule: fill only fields that are currently null or empty. Never touch the work-authorization or EEO fields. Always set `resumePath` and `resumeText`.

- [ ] **Step 1: Write failing tests**

```ts
test("defaults carry the user's stated answers", () => {
  const p = getProfile(openDb(":memory:"));
  expect(p).toMatchObject({ usCitizen: true, requiresSponsorship: false, hispanicLatino: true, disabilityStatus: "I do not want to answer" });
  expect(p.willingToRelocate).toBeNull();
});
test("profileValue derives fullName and graduationYear", () => {
  const p = { ...PROFILE_DEFAULTS, firstName: "Luis", lastName: "Z", graduationMonth: "2028-05" };
  expect(profileValue(p, "fullName")).toBe("Luis Z");
  expect(profileValue(p, "graduationYear")).toBe("2028");
});
test("importResume fills empty fields only and never touches EEO fields", async () => {
  const db = openDb(":memory:"); saveProfile(db, { email: "keep@x.com" });
  const llm = new FakeLlm().on("resume", () => ({ email: "other@x.com", firstName: "Luis", school: "UT", resumeText: "..." }));
  const p = await importResume(db, llm, "tests/fixtures/resume-sample.pdf");
  expect(p).toMatchObject({ email: "keep@x.com", firstName: "Luis", school: "UT", gender: "Male" });
  expect(llm.calls[0].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "document" })]));
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: profile with user defaults and resume import`

---

### Task 7: Answer bank, blockers, needs-you, overrides

**Files:**
- Create: `src/answers/bank.ts`, `src/answers/inbox.ts`
- Modify: `src/db/migrations.ts`
- Test: `tests/answers/bank.test.ts`

**Interfaces:**
- Consumes: `setStatus`, `getJob` (Task 4)
- Produces:
  - `interface Question { id: number; canonical: string; kind: "global" | "template"; isFactual: boolean; answer: string | null; draft: string | null; status: "none" | "draft" | "approved"; options: string[] | null; useCount: number; variants: string[] }`
  - `createQuestion(db, q: { canonical: string; kind: "global" | "template"; isFactual: boolean; options?: string[] | null; draft?: string | null }): Question` (status `draft` if a draft is given, else `none`). Also: `getQuestion(db, id)`, `listQuestions(db, q?: { status?: Question["status"]; search?: string }): Question[]`, `addVariant(db, id, label: string)` (ignores duplicates), `setDraft(db, id, text)`, `approveAnswer(db, id, text, kind?: "global" | "template")`, `deleteQuestion(db, id)`, `incrementUse(db, id)`
  - `addBlocker(db, jobId: string, questionId: number, reason: "missing" | "approval")`, `blockersForJob(db, jobId): { questionId: number; reason: string }[]`
  - `interface InboxItem { question: Question; jobs: { id: string; company: string; title: string }[] }` and `inboxItems(db): InboxItem[]`. Covers questions with status `none` or `draft` and ≥1 blocker, sorted by blocked-job count descending.
  - `addNeedsYou(db, n: { jobId: string; kind: "captcha" | "code" | "login" | "other"; message: string }): number`, `listOpenNeedsYou(db)`, `resolveNeedsYouForJob(db, jobId)`
  - `setOverride(db, jobId, fieldLabel: string, answer: FieldAnswer)`, `getOverrides(db, jobId): Record<string, FieldAnswer>`. `FieldAnswer` is defined in Task 8's `src/forms/types.ts`, so create that file in this task with the types listed under Task 8.
  - `inbox.ts`: `answerQuestion(db, questionId: number, text: string, kind?: "global" | "template"): { requeued: string[] }`. It approves the answer, deletes that question's blockers, and sets every job left with zero blockers and status `needs-you` to `queued`.
  - Migration tables: `questions`, `question_variants`, `job_blockers (job_id, question_id, reason, PK(job_id, question_id))`, `needs_you`, `job_overrides`, `field_cache` (used in Task 8).

- [ ] **Step 1: Write failing tests**

```ts
test("answering a question requeues only jobs with no remaining blockers", () => {
  // job A blocked by q1; job B blocked by q1 and q2; both status needs-you
  const { requeued } = answerQuestion(db, q1.id, "No");
  expect(requeued).toEqual([jobA.id]);
  expect(getJob(db, jobB.id)!.status).toBe("needs-you");
  expect(getQuestion(db, q1.id)).toMatchObject({ status: "approved", answer: "No" });
});
test("inboxItems groups jobs per question, most-blocking first", () => {});
test("addVariant dedupes labels", () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: answer bank, job blockers, needs-you items, per-job overrides`

---

### Task 8: Answer resolver

The core of the "learning" behavior. `resolveFields` decides each field's value in the spec §4.4 order.

**Files:**
- Create (or complete): `src/forms/types.ts`, `src/answers/classify.ts`, `src/answers/adapt.ts`, `src/answers/match.ts`, `src/answers/draft.ts`, `src/answers/resolve.ts`
- Test: `tests/answers/adapt.test.ts`, `tests/answers/resolve.test.ts`

**Interfaces:**
- Consumes: `Llm`, `FakeLlm` (Task 5); `Profile`, `profileValue`, `PROFILE_KEY_DESCRIPTIONS`, `getProfile` (Task 6); everything in `bank.ts` (Task 7); `hasSubmittedToCompany` (Task 4)
- Produces:
  - `forms/types.ts`:
    - `type FieldKind = "text" | "textarea" | "email" | "tel" | "url" | "number" | "date" | "select" | "combobox" | "radio" | "checkbox" | "checkbox-group" | "file"`
    - `interface FieldSpec { id: string; label: string; kind: FieldKind; required: boolean; options?: string[]; maxLength?: number; description?: string }`
    - `type FieldAnswer = { type: "text"; text: string } | { type: "option"; option: string } | { type: "options"; options: string[] } | { type: "check"; checked: boolean } | { type: "file"; path: string }`
    - `interface JobContext { jobId: string; company: string; title: string; location: string; term: string | null; description?: string }`
  - `classify.ts`:
    - `type FieldCategory = "profile" | "derived" | "consent-required" | "optin-optional" | "resume" | "cover-letter" | "question"`
    - `interface Classification { category: FieldCategory; profileKey?: ProfileKey; derivedKey?: "workedAtCompany" | "appliedToCompany" | "jobLocation" | "jobTerm"; canonicalQuestion?: string; isFactual: boolean; isCompanySpecific: boolean }`
    - `classifyFields(db, llm, fields: FieldSpec[], job: JobContext): Promise<Map<string, Classification>>`. Makes one LLM call per form (name `"classify"`, effort `low`) covering only the fields missing from `field_cache`. The cache key is sha1 of `kind | normalized label | sorted options`. Company names in labels are replaced with `{company}` before hashing.
  - `adapt.ts`:
    - `pickOption(value: string | boolean, options: string[]): string | null`. Deterministic: exact case-insensitive match, then normalized containment, then yes/no synonyms for booleans. Returns null when ambiguous.
    - `adaptAnswer(llm, value: string | boolean | string[], field: FieldSpec, job: JobContext): Promise<FieldAnswer | null>`. Tries deterministic adaptation first. Otherwise calls the LLM (name `"adapt"`, effort `low`), which returns `{ option: string | null }` for option fields or `{ text }` shortened under `maxLength`. A returned option must exactly match one of `field.options`; anything else is treated as null.
  - `match.ts`: `matchQuestion(llm, canonical: string, isFactual: boolean, candidates: Question[]): Promise<number | null>`. Prefilters to the 40 most similar candidates by word-trigram overlap, then makes an LLM call (name `"match"`, effort `low`) returning `{ matchId: number | null; confidence: "high" | "medium" | "low" }`. Accepts only `high`, or `medium` when the question is not factual.
  - `draft.ts`:
    - `draftAnswer(llm, profile: Profile, canonical: string, field: FieldSpec, job: JobContext): Promise<{ answerable: boolean; draft: string | null }>` (name `"draft"`, effort `medium`). The resume text and profile go in `cachedContext`. The prompt forbids inventing facts or experience.
    - `reviseDraft(llm, profile, canonical: string, draft: string, instruction: string): Promise<string>` (name `"revise"`)
    - `fillTemplate(llm, profile, template: string, field: FieldSpec, job: JobContext): Promise<string>` (name `"template"`)
  - `resolve.ts`:
    - `type Resolution = { fieldId: string; status: "filled"; answer: FieldAnswer; source: "override" | "profile" | "derived" | "consent" | "resume" | "bank" | "template" } | { fieldId: string; status: "skip" } | { fieldId: string; status: "blocked"; questionId: number; reason: "missing" | "approval" }`
    - `resolveFields(deps: { db: Db; llm: Llm }, fields: FieldSpec[], job: JobContext): Promise<Resolution[]>`
    - Order per field:
      1. A per-job override matched by label.
      2. Otherwise go by category:
         - **profile:** take the value and adapt it. A null or unadaptable value gives `blocked missing` if the field is required, else `skip`. A blocked field creates or reuses a factual global question with the field label as its canonical text.
         - **derived:** `workedAtCompany` = whether `profile.employers` contains the company; `appliedToCompany` = `hasSubmittedToCompany`; `jobLocation` = `job.location`; `jobTerm` = `job.term`. Each is then adapted.
         - **consent-required:** `check: true`. If it's a text field, the full name.
         - **optin-optional:** `skip`.
         - **resume:** `file: profile.resumePath`. Blocked if that's null.
         - **cover-letter:** `skip` if optional; if required, treat as a question.
         - **question:** see below.
    - Question path, given the classifier's `canonicalQuestion`:
      1. Look for an existing match with `matchQuestion` against approved and draft questions.
         - Approved global answer → `adaptAnswer` → `filled` (source `bank`). Also adds the label as a variant and increments use.
         - Approved template → `fillTemplate`, then adapt → `filled` (source `template`).
         - Matched question still in `draft` → `blocked approval`.
         - Matched question with status `none` → `blocked missing`.
      2. No match and the question is factual → create the question with status `none` → `blocked missing` if required, else `skip`.
      3. No match and not factual → `draftAnswer`. If answerable, create the question with the draft and `kind: isCompanySpecific ? "template" : "global"` → `blocked approval` if required. An optional field also blocks for approval, so the draft gets reviewed once. If not answerable → `blocked missing` if required, else `skip`.
    - `resolveFields` doesn't write `job_blockers`. The runner does (Task 13).

- [ ] **Step 1: Write failing tests**

```ts
// adapt.test.ts
test("pickOption maps booleans and near-matches; null when ambiguous", () => {
  expect(pickOption(true, ["Yes", "No"])).toBe("Yes");
  expect(pickOption("Hispanic or Latino", ["Hispanic or Latino", "Not Hispanic or Latino", "Decline"])).toBe("Hispanic or Latino");
  expect(pickOption("Male", ["Female", "Male", "Non-binary"])).toBe("Male");
  expect(pickOption("Texas", ["Yes", "No"])).toBeNull();
});
test("adaptAnswer never returns an option not in the list", async () => {
  const llm = new FakeLlm().on("adapt", () => ({ option: "Something else" }));
  expect(await adaptAnswer(llm, "U.S. citizen", select(["Citizen or permanent resident", "Visa holder"]), job)).toBeNull();
});
test("adaptAnswer shortens text over maxLength via LLM and enforces the limit", async () => {
  const llm = new FakeLlm().on("adapt", () => ({ text: "x".repeat(480) }));
  const a = await adaptAnswer(llm, "y".repeat(900), { ...textarea, maxLength: 500 }, job);
  expect(a).toEqual({ type: "text", text: "x".repeat(480) });
});

// resolve.test.ts — FakeLlm "classify" returns a fixed classification map per test
test("profile fields fill from profile; consent checks; opt-in skipped", async () => {});
test("required profile field with null value blocks as missing and creates one question", async () => {});
test("hispanic yes/no question resolves from profile.hispanicLatino", async () => {
  // classified profileKey hispanicLatino; options ["Yes","No"] → option "Yes"
});
test("unseen open question gets a draft and blocks for approval", async () => {});
test("approved bank answer is reused for a differently worded question", async () => {
  // bank has approved "Are you legally authorized to work in the US?" = "Yes"
  // field label "Do you have US work authorization?" → match returns that id → filled, source "bank"; variant added
});
test("factual question with no match blocks missing, never drafts", async () => {
  expect(llm.calls.some(c => c.name === "draft")).toBe(false);
});
test("template answer is filled for the current company", async () => {});
test("field_cache avoids a second classify call for the same form", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: answer resolver with classification cache, bank matching, drafts, templates`

---

### Task 9: Generic form extraction and filling

**Files:**
- Create: `src/forms/extract.ts`, `src/forms/fill.ts`
- Test: `tests/forms/extract.test.ts`, `tests/forms/fill.test.ts`, fixture `tests/fixtures/forms/basic.html`

**Interfaces:**
- Consumes: `FieldSpec`, `FieldAnswer` (Task 8 types)
- Produces:
  - `extractFields(root: Page | Frame, scope?: string): Promise<FieldSpec[]>`. Finds visible controls inside `scope` (CSS selector, default `form`). Each control gets a `data-aa-id="f<n>"` attribute, and `FieldSpec.id` is that value.
    - **Label resolution order:** `aria-labelledby`, then `label[for]`, then a wrapping `label`, then `aria-label`, then a fieldset `legend` (for radio and checkbox groups), then the nearest preceding text block in the same container.
    - **Required:** the `required` attribute, `aria-required`, or a trailing `*` in the label (which is then stripped).
    - **Grouping:** radio buttons and checkboxes sharing a `name` become one field. A checkbox group with more than one box becomes `checkbox-group`.
    - **Options:** a select's options exclude the placeholder (empty value). For `role=combobox`, options are read by opening the combobox and collecting `[role=option]` text, then pressing Escape. If no options appear without typing, `options` stays undefined.
    - **Other:** `maxLength` comes from the `maxlength` attribute. Hidden inputs are skipped, except file inputs whose visible trigger is a sibling or ancestor button/label.
  - `fillField(root: Page | Frame, field: FieldSpec, answer: FieldAnswer): Promise<void>`. Uses `fill` for text fields. Uses `selectOption({ label })` for selects. For comboboxes: click, type the option text, then click the `[role=option]` whose text equals it (falling back to one that starts with it). Clicks the radio whose label matches. Uses `setChecked` for checkboxes and `setInputFiles` for file inputs.
  - `readBack(root, field): Promise<string | string[] | boolean | null>` returns the current value as the user would see it.

- [ ] **Step 1: Write `basic.html`.** It needs one of each of:
  - text via `label[for]`, text via a wrapping label, text via `aria-labelledby`, and a required field marked by `*` only
  - a textarea with `maxlength=500`
  - a select with a placeholder
  - a radio group in a fieldset with a legend
  - a single consent checkbox and a 3-box checkbox group
  - a hidden file input with an "Attach" button
  - an ARIA combobox (≈30 lines of inline JS that shows `[role=option]` items filtered by the typed text)
  - a hidden input (must be ignored)
- [ ] **Step 2: Write failing tests**

```ts
test("extracts labels, kinds, required, options", async () => {
  await page.setContent(basicHtml);
  const f = await extractFields(page);
  expect(f.map(x => [x.label, x.kind, x.required])).toEqual([
    ["First Name", "text", true], ["Email", "email", true], ["LinkedIn Profile", "url", false], ["Phone", "tel", true],
    ["Why us?", "textarea", false], ["Degree", "select", true], ["Are you authorized to work in the US?", "radio", true],
    ["I certify the above is accurate", "checkbox", true], ["Which languages?", "checkbox-group", false],
    ["Resume", "file", true], ["School", "combobox", true],
  ]);
  expect(f.find(x => x.label === "Degree")!.options).toEqual(["Bachelor's", "Master's"]);
  expect(f.find(x => x.label === "Why us?")!.maxLength).toBe(500);
});
test("fillField + readBack round-trip every kind", async () => { /* one assertion per kind; combobox picks "University of Texas at Austin" */ });
```

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat: generic DOM form extraction and filling`

---

### Task 10: ATS handler contract and Greenhouse

**Files:**
- Create: `src/ats/types.ts`, `src/ats/registry.ts`, `src/ats/greenhouse.ts`, `scripts/capture-fixture.ts`, `tests/live/dry-run.ts`
- Test: `tests/ats/registry.test.ts`, `tests/ats/greenhouse.test.ts`, `tests/live/greenhouse.live.test.ts`
- Fixtures: `tests/fixtures/greenhouse/job-boards.html`, `tests/fixtures/greenhouse/boards-legacy.html` (captured)

**Interfaces:**
- Consumes: `extractFields`, `fillField`, `readBack` (Task 9)
- Produces:
  - `type OpenResult = { ok: true } | { ok: false; reason: "closed" | "not-found" | "already-applied"; detail?: string }`
  - `type SubmitOutcome = { kind: "submitted" } | { kind: "captcha" } | { kind: "verification-code" } | { kind: "validation-error"; messages: string[] } | { kind: "already-applied" } | { kind: "pending" } | { kind: "unknown"; detail: string }`
  - `interface AtsHandler { name: string; matches(url: string): boolean; open(page: Page, url: string): Promise<OpenResult>; root(page: Page): Promise<Page | Frame>; readFields(page: Page): Promise<FieldSpec[]>; fill(page: Page, field: FieldSpec, answer: FieldAnswer): Promise<void>; readBack(page: Page, field: FieldSpec): Promise<string | string[] | boolean | null>; submit(page: Page): Promise<void>; outcome(page: Page): Promise<SubmitOutcome>; description(page: Page): Promise<string | undefined> }`
  - `registry.ts`: `HANDLERS: AtsHandler[]`, `detectAts(url: string, handlers?: AtsHandler[]): AtsHandler | null`, `atsNameFromUrl(url: string): string`. The second returns `"workday" | "greenhouse" | "lever" | "ashby" | "oracle" | "smartrecruiters" | "other"`, used for display and stats.
  - `greenhouse: AtsHandler`
    - **matches:** hosts `job-boards.greenhouse.io`, `boards.greenhouse.io`, `job-boards.eu.greenhouse.io`, or any URL with a `gh_jid` param.
    - **open:**
      1. Navigate to the URL.
      2. If the page is not a greenhouse host and embeds an `iframe[src*="greenhouse.io"]`, navigate to that iframe's `src`.
      3. If a link or button named /apply/i hides the form, click it.
      4. Return `closed` when the page says the job is no longer open, or when there is no form.
    - **readFields:** `extractFields(root, "#application-form, form#application_form")`. React-select comboboxes get their options by opening each. The education section's school/degree/discipline comboboxes are async-search, so their options stay undefined and they're filled by typing.
    - **submit:** clicks the button named /submit application/i.
    - **outcome:**
      - URL contains `confirmation`, or the text matches /thank you for applying|application (has been )?(submitted|received)/i → `submitted`
      - a visible `iframe[src*="recaptcha"][title*="challenge"]` or an hCaptcha challenge → `captcha`
      - text /security code|verification code/ with an input → `verification-code`
      - visible elements matching `[class*="error"], [aria-invalid="true"]` with text → `validation-error` with those messages
      - otherwise `pending`
  - `scripts/capture-fixture.ts <url> <outfile>`: opens a headed browser, runs the matching handler's `open`, waits for network idle, and writes `page.content()` to `outfile`.
  - `tests/live/dry-run.ts`: `dryRun(handler: AtsHandler, url: string): Promise<{ fields: FieldSpec[]; unfilledRequired: string[]; submitVisible: boolean }>`. Fills each field with a kind-appropriate dummy (text `"Test"`, email `test@example.com`, the first option, checked, `tests/fixtures/resume-sample.pdf`) and reads it back. Never clicks submit.

- [ ] **Step 1: Capture fixtures.** Pick two current Greenhouse URLs from the live listings: one `job-boards.greenhouse.io` and one `boards.greenhouse.io`. Run `pnpm tsx scripts/capture-fixture.ts <url> tests/fixtures/greenhouse/<name>.html`. The selectors above are starting points. Confirm them against the captured DOM and adjust.
- [ ] **Step 2: Write failing tests**

```ts
test("detectAts routes by URL", () => {
  expect(detectAts("https://job-boards.greenhouse.io/digs/jobs/4663939006")?.name).toBe("greenhouse");
  expect(detectAts("http://block.xyz/careers/jobs/5108007008?gh_jid=5108007008")?.name).toBe("greenhouse");
  expect(detectAts("https://visa.wd5.myworkdayjobs.com/Visa/job/x")).toBeNull();
  expect(atsNameFromUrl("https://visa.wd5.myworkdayjobs.com/Visa/job/x")).toBe("workday");
});
test("greenhouse fixture: core fields extracted", async () => {
  await page.setContent(fixture);
  const labels = (await greenhouse.readFields(page)).map(f => f.label.toLowerCase());
  for (const l of ["first name", "last name", "email", "resume"]) expect(labels.some(x => x.includes(l))).toBe(true);
});
test("greenhouse outcome detects confirmation and validation errors", async () => { /* setContent with small HTML snippets */ });
// tests/live/greenhouse.live.test.ts (LIVE=1): dryRun on a current posting → unfilledRequired = [] and submitVisible = true
```

- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** `pnpm test` → PASS; `pnpm test:live -t greenhouse` → PASS.
- [ ] **Step 6: Commit** `feat: ATS handler contract, registry, Greenhouse handler`

---

### Task 11: Lever handler

**Files:**
- Create: `src/ats/lever.ts`; modify `src/ats/registry.ts`
- Test: `tests/ats/lever.test.ts`, `tests/live/lever.live.test.ts`; fixture `tests/fixtures/lever/apply.html` (captured)

**Interfaces:**
- Consumes: `AtsHandler` contract (Task 10)
- Produces: `lever: AtsHandler`
  - **matches:** `jobs.lever.co`, `jobs.eu.lever.co`
  - **open:** append `/apply` if missing; a 404 or "no longer accepting" → `closed`
  - **readFields:** scope `form` on the apply page. Lever's single `Full name` field (`name="name"`) is classified as `fullName`. Custom question "cards" and `eeo[...]` selects come through the generic extractor.
  - **submit:** `#btn-submit` or the button named /submit application/i
  - **outcome:** URL ends `/thanks` or text /application submitted|thanks for applying/i → `submitted`; an hCaptcha challenge iframe → `captcha`; `.error-message`/`[aria-invalid]` → `validation-error`

- [ ] **Step 1: Capture** a current Lever fixture.
- [ ] **Step 2: Write failing tests:**
  - matches + `/apply` normalization: `open` given `https://jobs.lever.co/make-rain/b45f…` navigates to `…/apply`. Use a route stub so the test runs offline.
  - fixture extraction includes `Full name`, `Email`, `Resume/CV`
  - outcome on a thanks snippet
  - live dry run
- [ ] **Step 3–5:** run → FAIL, implement, run → PASS.
- [ ] **Step 6: Commit** `feat: Lever handler`

---

### Task 12: Ashby handler

**Files:**
- Create: `src/ats/ashby.ts`; modify `src/ats/registry.ts`
- Test: `tests/ats/ashby.test.ts`, `tests/live/ashby.live.test.ts`; fixture `tests/fixtures/ashby/application.html` (captured)

**Interfaces:**
- Produces: `ashby: AtsHandler`
  - **matches:** `jobs.ashbyhq.com`
  - **open:** ensure the path ends `/application`
  - **readFields:** the generic extractor plus one Ashby-specific widget. Yes/No questions are rendered as two buttons in a container rather than radios, so each container whose question label is followed by exactly two `button`s with text Yes/No becomes `{ kind: "radio", options: ["Yes", "No"] }`. Its `fill` clicks the matching button and its `readBack` reads the selected button (the `aria-pressed` attribute or a selected class, whichever the fixture shows).
  - **submit:** the button named /submit application/i
  - **outcome:** text /thank you for applying|application (was )?submitted/i → `submitted`; text /couldn't submit|flagged as spam|try again/i → `unknown` with that text; field errors → `validation-error`

- [ ] **Step 1: Capture** a current Ashby fixture that includes a Yes/No question.
- [ ] **Step 2: Write failing tests:** Yes/No button groups extracted as radio and round-trip via `fill`/`readBack`; core fields present; the outcome cases; live dry run.
- [ ] **Step 3–5:** run → FAIL, implement, run → PASS.
- [ ] **Step 6: Commit** `feat: Ashby handler`

---

### Task 13: Runner

**Files:**
- Create: `src/runner/runner.ts`, `src/runner/records.ts`, `src/runner/notify.ts`, `src/runner/browser.ts`
- Modify: `src/db/migrations.ts` (append `job_snapshots(job_id PK, fields_json, resolutions_json, screenshot_path, created_at)`)
- Test: `tests/runner/runner.test.ts`; fixture `tests/fixtures/forms/mini-ats.html` plus `tests/helpers/mini-ats-handler.ts`. The mini handler is an `AtsHandler` that serves that fixture and matches `https://mini-ats.test/`. The fixture's submit validates that phone is digits only: if valid, it shows "Thank you for applying"; if not, it shows `<span class="error">Invalid phone</span>`. A `?captcha=1` query shows a fake challenge iframe until a "solve" button is clicked.

**Interfaces:**
- Consumes: jobs repo (Task 4), `resolveFields` + `classify` etc. (Task 8), bank/blockers/needs-you/overrides (Task 7), `getSettings` (Task 1), `detectAts`/`HANDLERS` (Task 10)
- Produces:
  - `interface BrowserProvider { open(opts: { headless: boolean }): Promise<{ page: Page; close(): Promise<void> }> }` and `persistentChromium: BrowserProvider` (in `browser.ts`, a persistent context at `BROWSER_PROFILE_DIR`)
  - `interface RunnerDeps { db: Db; llm: Llm; browser: BrowserProvider; notify(title: string, message: string): Promise<void>; now(): Date; handlers?: AtsHandler[]; humanWaitMs?: number /* default 600_000 */; pollMs?: number /* default 5_000 */ }`
  - `type RunMode = "auto" | "submit-reviewed" | "interactive"`
  - `runJob(deps: RunnerDeps, jobId: string, mode?: RunMode): Promise<JobStatus>`
  - `runNext(deps: RunnerDeps): Promise<JobStatus | null>`. Returns null when settings say `paused`, when no job is queued, or when the daily limit is reached; in the last case the job stays `queued`.
  - `records.ts`: `saveRecord(jobId: string, r: { screenshots: Buffer[]; answers: { label: string; value: unknown; source: string }[]; outcome: string }): string` (returns the directory `RECORDS_DIR/<jobId>/<ISO time>/`), `listRecords(jobId): string[]`
  - `notify.ts`: `macNotify(title, message): Promise<void>` via `osascript -e 'display notification …'`. Never throws.
- **Flow of `runJob`:**
  1. Find the handler with `detectAts`. If there is none, set `unsupported` with reason `atsNameFromUrl(url)` and stop.
  2. Set the job to `filling` and increment attempts.
  3. Open a page (headless per settings; `interactive` mode always runs headed). Call `handler.open`. A failed open sets `closed`, `not-found` → `failed`, or `already-applied` → `applied-manually`.
  4. Read the fields and build the `JobContext` (description from `handler.description`).
  5. Call `resolveFields`. If any resolution is `blocked`: write the blockers, set `needs-you` with reason `"N questions need you"`, take a screenshot, save the snapshot, and stop. Never fill or submit in this case.
  6. Fill every `filled` resolution, then compare each with `readBack`. A required field that reads back empty sets `failed` with reason `Could not fill "<label>"`, after a screenshot.
  7. If `mode === "auto"` and review applies (`reviewMode === "all"`, or `"companies"` with a case-insensitive company match), save the snapshot and screenshot, set `ready-to-review`, and stop.
  8. Check the daily limit using `submittedSince(start of today)`. If reached, set the job back to `queued` and stop.
  9. Call `handler.submit`, then poll `handler.outcome` every `pollMs` for up to 30s while it says `pending`.
     - `submitted` → save a record, set `submitted` with `submittedAt`, and increment `useCount` for the bank questions used.
     - `validation-error` → `failed` with the messages joined.
     - `already-applied` → `applied-manually`.
     - `captcha` or `verification-code` → call `notify`, add a needs-you item, then poll `outcome` until `submitted` or until `humanWaitMs` runs out (a large value in `interactive` mode). On submission, finish as above and resolve the needs-you item. On timeout, set `needs-you` with reason `"CAPTCHA"` or `"Verification code"`.
     - `unknown` or still `pending` → `failed` with the detail and a screenshot.
  10. Any thrown error sets `failed` with its message and a screenshot, if a page exists.
  11. Always close the page.
  
  `submit-reviewed` runs the same flow but skips the review gate. Overrides are applied by `resolveFields`.

- [ ] **Step 1: Write failing tests** (FakeLlm + mini-ats handler + real Playwright)

```ts
test("auto mode fills and submits; record saved", async () => {
  expect(await runJob(deps, job.id)).toBe("submitted");
  expect(listRecords(job.id)).toHaveLength(1);
});
test("review mode stops at ready-to-review without submitting", async () => {
  saveSettings(db, { reviewMode: "all" });
  expect(await runJob(deps, job.id)).toBe("ready-to-review");
  expect(fixtureSubmitCount()).toBe(0);
});
test("submit-reviewed submits a ready-to-review job and applies overrides", async () => {});
test("unknown required question → needs-you with blocker, nothing filled or submitted", async () => {
  expect(await runJob(deps, job.id)).toBe("needs-you");
  expect(blockersForJob(db, job.id)).toHaveLength(1);
  expect(fixtureSubmitCount()).toBe(0);
});
test("unapproved draft blocks submission", async () => {});
test("validation error after submit → failed with page messages", async () => {
  // profile phone "555-ABC"
  expect(await runJob(deps, job.id)).toBe("failed");
  expect(getJob(db, job.id)!.statusReason).toContain("Invalid phone");
});
test("daily limit leaves job queued", async () => {});
test("captcha: notifies, waits, then needs-you after humanWaitMs", async () => {
  // humanWaitMs: 300, pollMs: 50
  expect(await runJob({ ...deps, humanWaitMs: 300, pollMs: 50 }, captchaJob.id)).toBe("needs-you");
  expect(notifications).toHaveLength(1);
  expect(listOpenNeedsYou(db)[0].kind).toBe("captcha");
});
test("unsupported ATS → unsupported with ats name", async () => {});
test("runNext returns null when paused", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: application runner with review gate, daily limit, human-wait, records`

---

### Task 14: Dashboard shell and Inbox

**Files:**
- Create: `src/web/server.ts`, `src/web/layout.tsx`, `src/web/pages/inbox.tsx`
- Test: `tests/web/inbox.test.ts`

**Interfaces:**
- Consumes: `inboxItems`, `answerQuestion`, `setDraft`, `getQuestion` (Task 7); `reviseDraft` (Task 8); `listOpenNeedsYou` (Task 7); `runJob` (Task 13); `countByStatus` (Task 4)
- Produces:
  - `createApp(ctx: AppContext): Hono` with `interface AppContext { db: Db; llm: Llm; runInteractive(jobId: string): void /* fire-and-forget */; pollNow(): void }`
  - `Layout` renders the nav tabs **Inbox · Applications · Answer bank · Profile & resume · Sources & filters · Settings**, with a count badge on Inbox (open questions + needs-you items). It loads htmx from `https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js`. Styling is light/dark CSS variables in a `<style>` block.
  - Routes:
    - `GET /` → redirect to `/inbox`
    - `GET /inbox` renders one card per `InboxItem`:
      - the canonical question, `Blocking N jobs · <company>, <company>, +k`, and the variants
      - when there's a draft: buttons **Use draft**, **Edit**, and **Tell AI what to change**
      - when there isn't: a field shaped by `options` (a select if present, else a textarea)
      - a **Save as template** checkbox that's visible when the question kind is `template`
      
      Below the cards is a **Needs you** section listing open needs-you items, each with a **Do it now** button.
    - `POST /inbox/:id/answer` (form `text`, `kind?`) → `answerQuestion` → returns an htmx swap that removes the card and shows "Saved · N jobs re-queued"
    - `POST /inbox/:id/use-draft` → approves the stored draft
    - `POST /inbox/:id/revise` (form `instruction`) → `reviseDraft` → `setDraft` → returns the re-rendered card
    - `POST /needs-you/:jobId/do-it-now` → `runInteractive(jobId)`, returns "Opening browser…"

- [ ] **Step 1: Write failing tests** using `app.request()`:
  - `GET /inbox` lists a seeded blocked question with "Blocking 2 jobs"
  - `POST /inbox/:id/answer` approves it and requeues both jobs, and the response says "2 jobs re-queued"
  - `POST /inbox/:id/revise` calls FakeLlm `"revise"` and the card shows the new draft
  - `POST /needs-you/:jobId/do-it-now` calls `runInteractive` with that id
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat: dashboard shell and question-first inbox`

---

### Task 15: Applications tab and review flow

**Files:**
- Create: `src/web/pages/applications.tsx`; modify `src/web/server.ts`
- Test: `tests/web/applications.test.ts`

**Interfaces:**
- Consumes: `listJobs`, `countByStatus`, `getJob`, `setStatus` (Task 4); `job_snapshots`, `listRecords` (Task 13); `setOverride`, `approveAnswer` (Task 7)
- Produces routes:
  - `GET /applications?status=<JobStatus>&page=<n>`: status filter chips with counts, then a table of company, title, chosen location, posted date, ATS, status, and reason. Shows 50 per page.
  - `GET /applications/:id`: job info, link to the posting, status history reason, last screenshot (served from `GET /records/*`, restricted to `RECORDS_DIR`), and the snapshot's fields with value + source.
    - For `ready-to-review` jobs, every field is editable.
    - Buttons by status: **Submit** (ready-to-review), **Skip** (→ `skipped` with reason "Skipped by you"), **Retry** (failed/unsupported → `queued`), **Mark applied manually**.
  - `POST /applications/:id/field` (form `label`, `value`, `saveToBank?`): `setOverride`. If `saveToBank` is set and the field came from the bank, it also runs `approveAnswer` on that question.
  - `POST /applications/:id/submit`: runs `runJob(…, "submit-reviewed")` through the `AppContext`. This adds `runReviewed(jobId: string): void` to the `AppContext` interface from Task 14.
  - `POST /applications/:id/skip`, `/retry`, `/mark-applied`

- [ ] **Step 1: Write failing tests:**
  - list filtering by status shows correct counts
  - the detail page of a ready-to-review job renders editable inputs for each snapshot field
  - an override POST persists via `getOverrides`
  - the submit POST calls `runReviewed`
  - retry moves `failed` → `queued`
  - `/records/../app.db` → 404
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat: applications list, job detail, review and submit`

---

### Task 16: Answer bank, Profile, Sources & filters, Settings tabs

**Files:**
- Create: `src/web/pages/{bank,profile,sources,settings}.tsx`, `src/secrets.ts`; modify `src/web/server.ts`, `src/llm/llm.ts` (ClaudeLlm reads the key from Keychain if present)
- Test: `tests/web/bank.test.ts`, `tests/web/profile.test.ts`, `tests/web/sources.test.ts`, `tests/web/settings.test.ts`, `tests/secrets.test.ts`

**Interfaces:**
- Produces:
  - `secrets.ts`: `getSecret(name: string): Promise<string | null>` and `setSecret(name: string, value: string): Promise<void>`. Both use `execFile("security", ["find-generic-password" | "add-generic-password", "-U", "-s", "ai-applier", "-a", name, "-w", …])`. They accept an injectable runner for tests.
  - **Answer bank** (`GET /bank?search=`): a list of questions with status, answer, variants, kind, and use count. `POST /bank/:id` edits the answer and kind (marks it approved). `POST /bank/:id/delete` removes it.
  - **Profile & resume**:
    - `GET /profile` is a form for every `ProfileSchema` field, grouped Contact / Education / Work authorization / Demographics. Booleans render as Yes/No selects.
    - `POST /profile` saves it.
    - `POST /profile/resume` (multipart PDF) runs `importResume` and shows "Filled N fields from your resume".
  - **Sources & filters**:
    - `GET /sources` lists the sources (enable toggle, last polled, last error) and has a form to add a GitHub URL. A URL ending `listings.json` gets kind `simplify-json`. A `github.com/<owner>/<repo>` URL is converted to `raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md` with kind `readme-table`.
    - The filter form covers every `FilterRules` field, with lists entered comma-separated.
    - `GET /filters/preview` (htmx, form values as query) returns "N of M current postings match". It evaluates against the latest postings of all jobs in the DB.
    - `POST /filters` saves the filters. `POST /sources/poll` → `pollNow()`.
  - **Settings**:
    - `GET /settings` covers review mode (off / all / companies + company list), daily limit, poll minutes, headless, paused, and the Anthropic API key (write-only field showing "set ✓" / "not set").
    - `POST /settings` saves them, and saves the key via `setSecret("anthropic-api-key", …)` only when the field is non-empty.

- [ ] **Step 1: Write failing tests:**
  - bank edit approves the answer
  - profile POST round-trips booleans
  - adding `https://github.com/SimplifyJobs/New-Grad-Positions` creates a `readme-table` source with the raw README URL
  - preview returns the right count for seeded jobs under the default filters
  - settings POST persists and calls `setSecret` only when a key is provided
  - `getSecret` returns null when `security` exits 44
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat: answer bank, profile, sources/filters, settings tabs`

---

### Task 17: Wiring, scheduler, and end-to-end smoke run

**Files:**
- Create: `src/main.ts`, `README.md`
- Test: `tests/main.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `startApp(opts: { dataDir?: string; port?: number; startLoops?: boolean }): Promise<{ url: string; stop(): Promise<void> }>`. It:
    1. opens the DB
    2. builds `ClaudeLlm` with the key from Keychain, falling back to SDK default credentials
    3. serves `createApp` on `127.0.0.1:4310`
    4. if `startLoops`, polls immediately and then every `pollMinutes` (re-read each cycle)
    5. if `startLoops`, runs the runner loop: `runNext`; when it returns null, sleep 30s; one job at a time, with errors logged and the loop continuing
    
    `runInteractive` and `runReviewed` are queued and run between `runNext` iterations, never concurrently with another job.
  - `main.ts` calls `startApp({ startLoops: true })`, logs the URL, and handles SIGINT by calling `stop()`.
  - README: setup (`pnpm i`, `pnpm exec playwright install chromium`, `pnpm start`, open `http://127.0.0.1:4310`), first-run checklist (upload resume → review profile → check filters preview → watch Inbox), and how review mode / pause work.

- [ ] **Step 1: Write failing test:** `startApp({ dataDir: tmp, port: 0, startLoops: false })` serves `/inbox` with 200 and `stop()` resolves.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Manual smoke run (no submissions)**
  1. Start with `AI_APPLIER_DATA=./data-smoke pnpm start`.
  2. In Settings, set Paused on.
  3. Upload `tests/fixtures/resume-sample.pdf`, then press "Poll now".
  
  Expected: the Applications tab shows a few hundred jobs. `queued` covers Software postings from the last 14 days outside Canada. Skipped jobs show reasons. Workday rows exist and will become `unsupported` once run. The filter preview count matches the queued count.
- [ ] **Step 6: Manual dry run of one real job**
  1. Set review mode to `all` and un-pause.
  2. Let one Greenhouse/Lever/Ashby job run.
  
  Expected: the job reaches `needs-you` with inbox questions, or reaches `ready-to-review` with a screenshot and every field filled. **Do not press Submit** during the smoke run.
- [ ] **Step 7: Run** `pnpm test && pnpm typecheck` → all PASS.
- [ ] **Step 8: Commit** `feat: app wiring, scheduler loops, README`

---

### Task 18: Application tracker spreadsheet (CSV + optional Google Sheet)

Spec §4.11 (added 2026-10-28 at the user's request).

**Files:**
- Create: `src/tracker/rows.ts`, `src/tracker/csv.ts`, `src/tracker/sheets.ts`, `src/tracker/sync.ts`
- Modify: `src/runner/runner.ts` (record which resume and cover letter were used), `src/db/migrations.ts`, `src/web/pages/settings.tsx` + `src/web/server.ts` (tracker settings + Sync now), `src/main.ts` (wire the syncer)
- Test: `tests/tracker/rows.test.ts`, `tests/tracker/csv.test.ts`, `tests/tracker/sheets.test.ts`, `tests/tracker/sync.test.ts`, `tests/web/settings.test.ts` (extend)

**Interfaces:**
- Consumes:
  - jobs repo (Task 4)
  - records and snapshots (Task 13)
  - `runJob` end states (Task 13)
  - settings and `secrets.ts` (Tasks 1, 16)
  - `startApp` (Task 17)
- Produces:
  - **Migration:** add columns `resume_used TEXT` and `cover_letter_used TEXT` to `jobs`. When the runner reaches `submitted`, it sets these:
    - `resume_used`: the basename of the resume file it uploaded.
    - `cover_letter_used`: the cover-letter file basename; or `"written answer"` if a cover-letter text field was filled; otherwise `"none"`.
  - **`rows.ts`:**
    - `TRACKER_HEADERS = ["Date applied", "Company", "Job title", "Posting link", "Location", "Resume used", "Cover letter used", "Status", "Application system"]`
    - `trackerRows(db): string[][]` returns the jobs with status `submitted` or `applied-manually`, newest first. Dates are `YYYY-MM-DD` in local time, taken from `submittedAt`, falling back to `updatedAt` for applied-manually. Location is `chosenLocation`. Application system is `atsNameFromUrl(url)`. Unknown values are an empty string.
  - **`csv.ts`:** `writeTrackerCsv(db, file = path.join(paths.dataDir, "applications.csv")): void`. Writes the full file as RFC 4180 (quote fields containing `,`, `"` or newlines; double the quotes) through a temp file plus rename.
  - **`sheets.ts`:** `interface SheetsClient { replaceTab(spreadsheetId: string, tab: string, rows: string[][]): Promise<void> }` and `googleSheetsClient(serviceAccountJson: string): SheetsClient`.
    - Uses `google-auth-library` with a JWT for scope `https://www.googleapis.com/auth/spreadsheets`, then `fetch` against the Sheets REST API:
      1. Create the tab if it's missing (`batchUpdate addSheet`).
      2. `values:clear` on `<tab>`.
      3. `values:update` at `<tab>!A1` with `valueInputOption=RAW`.
    - `spreadsheetIdFromUrl(url: string): string | null` parses `/spreadsheets/d/<id>/`.
  - **`sync.ts`:** `syncTracker(db, deps: { sheets?: SheetsClient; now(): Date }): Promise<{ csv: true; sheet: "ok" | "skipped" | "error"; error?: string }>`.
    - Always writes the CSV.
    - If the settings key `trackerSheetUrl` and the Keychain secret `google-service-account` are both set, calls `replaceTab(id, "Applications", [TRACKER_HEADERS, ...rows])`.
    - Stores `{ lastSyncAt, lastError }` under the kv key `trackerSync`.
    - Never throws.
  - **Wiring:**
    - `RunnerDeps` gains an optional `onSubmitted?(jobId: string): void`. The runner calls it after a job ends `submitted`, and the applied-manually route calls it too.
    - In `startApp` it calls `syncTracker` without awaiting it in the runner path, and errors are swallowed into `trackerSync`.
  - **Settings tab:**
    - **Tracker spreadsheet** section with:
      - a Google Sheet URL field
      - a service-account key upload (a JSON file stored with `setSecret("google-service-account", …)`, never on disk)
      - the service account's `client_email` shown so the user knows whom to share the Sheet with
      - the last sync time and error
      - a **Sync now** button (`POST /tracker/sync`)
      - a link to download the CSV (`GET /tracker.csv`)

- [ ] **Step 1: Write failing tests**

```ts
test("trackerRows lists submitted + applied-manually jobs with all columns", () => {
  // seed: one submitted (resume_used "resume.pdf", cover "none"), one applied-manually, one queued
  const rows = trackerRows(db);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(["2026-10-28", "Acme", "Software Engineer Intern", "https://job-boards.greenhouse.io/acme/jobs/1", "NYC", "resume.pdf", "none", "submitted", "greenhouse"]);
});
test("CSV quotes commas and quotes and is rewritten, not appended", () => { /* write twice → same content; title 'Intern, "AI"' → "Intern, ""AI""" */ });
test("syncTracker writes CSV and skips the sheet when not configured", async () => {
  expect(await syncTracker(db, { now })).toMatchObject({ csv: true, sheet: "skipped" });
});
test("syncTracker sends headers + rows to replaceTab and records success", async () => { /* fake SheetsClient captures args */ });
test("a failing sheet client is reported, not thrown", async () => {
  const r = await syncTracker(db, { sheets: { replaceTab: async () => { throw new Error("403 PERMISSION_DENIED") } }, now });
  expect(r).toMatchObject({ sheet: "error", error: expect.stringContaining("403") });
});
test("spreadsheetIdFromUrl", () => expect(spreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/abc123/edit#gid=0")).toBe("abc123"));
test("runner records resume_used and cover_letter_used on submit and calls onSubmitted", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (`pnpm add google-auth-library`). **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat: application tracker spreadsheet (CSV + Google Sheets sync)`

---

## Self-review notes

- **Spec coverage.** Each spec section maps to these tasks:

  | Spec section | Tasks |
  |---|---|
  | §4.1 | 2, 4 |
  | §4.2 | 3, 16 |
  | §4.3 | 6, 16 |
  | §4.4 | 8 |
  | §4.5 | 7, 14 |
  | §4.6 (Greenhouse/Lever/Ashby, visible browser, multi-page) | 9–13 |
  | §4.8 | 13, 15 |
  | §4.9 | 4, 13 |
  | §4.10 | 14–16 |
  | §7 success criteria 1, 2, 4, 5 | 17 smoke, 13 tests |

  Multi-page forms are not needed by these three systems; the runner handles one page and Plan 2 adds a page loop for Workday.
- **Deferred to Plan 2:** §4.7 (accounts, email codes) and success criterion 3 (Workday). Greenhouse's email security code is handled here as a human-wait `verification-code` and automated in Plan 2 with IMAP.
- **Deferred to Plan 3:** Oracle, SmartRecruiters, and the generic handler. Those jobs sit as `unsupported` and the Retry button requeues them.

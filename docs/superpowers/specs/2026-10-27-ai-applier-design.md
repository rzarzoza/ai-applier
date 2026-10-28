# AI Applier — Design

Date: 2026-10-27
Status: approved 2026-10-27

## 1. Intent

The user applies to many internships, mostly from the SimplifyJobs GitHub list
(https://github.com/SimplifyJobs/Summer2027-Internships). Every application site
asks the same questions over and over. The user wants a program that:

- watches job lists on GitHub by itself, so they never paste a link;
- opens each job's **direct** application page (not Simplify's) and fills in
  everything from one resume and a bank of saved answers;
- learns: when it meets a question it can't answer, it flags it as
  "missing input" on a dashboard; the user answers once (or tells the AI what to
  write), and that answer is reused on every later application that asks the
  same thing;
- submits automatically by default, with an option to review before submitting;
- only applies to jobs that pass the user's filters (e.g. Software Engineering
  roles only, nothing in Canada).

The user named the hard part: reliably getting from a list entry to the real
application form, reading every field on it correctly, generating the right
answer, and filling it in correctly. That is where the effort should go.

## 2. Goals, non-goals, anti-goals

**Goals**
- Continuous, hands-off intake of postings from SimplifyJobs and other sources.
- Configurable filters, Software-only and excluding Canada as the user's
  starting setup.
- End-to-end filling and submitting on the major application systems, Workday
  included, with account creation and login.
- An answer bank that grows from the user's answers and is reused across sites,
  even when the same question is worded differently.
- A local dashboard built around a question-first inbox (user chose this
  layout).
- Auto-submit by default; review mode as an option.

**Non-goals (this version)**
- Resume tailoring and generating project ideas per job. Planned for later.
  Leave room for it (resume is a swappable input per application), but build
  nothing for it now.
- The Simplify "apply" button or Simplify's own autofill. The user doesn't want
  it used.
- Solving or bypassing CAPTCHAs.
- Multiple users, hosting, or cloud deployment. It's a single-user local app.
- Writing cover letters, unless a form strictly requires one (then treat it as
  any other free-text question: AI draft → approval once).

**Anti-goals (failure even if it "works")**
- Submitting an application with a blank required field, a guessed answer to a
  factual question (work authorization, graduation date, GPA, sponsorship), or
  made-up experience.
- Applying to the same job twice, or getting the user's portal accounts locked
  by repeated failed logins.
- Asking the user the same question twice.
- Quietly failing. Every job ends in a visible state, with a reason when it
  didn't submit.

## 3. Decisions already made

| Decision | Made by |
|---|---|
| TypeScript, Playwright driving Chromium, runs on the user's Mac | Claude (user had no preference) |
| Claude API for reading the resume, reading forms, matching questions, drafting answers | Claude |
| Question-first inbox (layout "B") as the main dashboard screen | User |
| Auto-submit on by default; review mode as an option | User |
| One email + password used for all portals; try login first, create account if login fails | User |
| App may read the user's inbox to fetch verification codes | User (agreed) |
| Uses the direct application link only, never Simplify's | User |
| Filters: Software category only; exclude Canada; filters are editable rules | User |
| Resume tailoring deferred | User |
| Only postings from the last 14 days (default for the "posted within" filter) | User |
| Same password on all existing portal accounts; no password resets | User |
| May tick legal/consent boxes and e-sign with typed name | User |
| EEO/work-auth answers: US citizen, no sponsorship, Latino, male, straight, he/him, not a veteran, disability "prefer not to answer" | User |

## 4. How it works

### 4.1 Sources (job intake)

- **SimplifyJobs adapter.** Poll
  `https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json`.
  This is the structured file the README is generated from. Each entry has:
  `id, company_name, title, url (direct application link), locations[], category,
  sponsorship, degrees[], terms[], date_posted, date_updated, active, is_visible`.
  Take entries with `active && is_visible`. The repo URL is configurable, so the
  same adapter works for sibling repos with the same format (e.g. New Grad
  lists).
- **README-table adapter** for other GitHub repos that only have a Markdown or
  HTML table. Pick out company, title, location, and the direct apply link.
  Ignore links to `simplify.jobs`.
- **Source interface** so more sources can be added later without touching the
  rest of the app.
- **Polling:** every 30 minutes by default (Claude's call; configurable). Use
  conditional requests (ETag) to avoid re-downloading the ~1 MB file when it
  hasn't changed.
- **De-duplication:** by source id, and also by normalized URL (strip
  `utm_*`/`ref` query params). A job is never queued twice. Postings that go
  inactive before they've been applied to are marked "closed".
- **Same role, several locations** (shown as `↳` rows in the README, often
  separate requisitions): apply once per company + normalized title + term,
  using the first location that passes the filters. The other rows are marked
  "duplicate role" (Claude's call).
- **First run / backlog:** there's no special first-run mode. The "posted
  within N days" filter (default **14**, set by the user) decides how much of
  the existing list gets queued, both on the first run and afterwards. No import
  of jobs already applied to by hand. If a site says "you've already applied",
  the job is marked "applied manually", not "failed".

Recon (2026-10-27): about 4,950 active postings. Where their direct links go:
Workday 39%, company-built sites 30% (Amazon, Meta, Tesla, Microsoft, TikTok,
Apple, Google…), Greenhouse 11%, Oracle Cloud 7%, Ashby 6%, Lever 3%,
SmartRecruiters 2%, others under 1% each. Category values seen: `Software`,
`AI/ML/Data`, `Hardware`, `Product`, `Quant`, plus a few long-form variants
such as `Software Engineering`. The `sponsorship` field is almost always
`Other`, so it can't be relied on for filtering.

### 4.2 Filters

Rules the user edits in the dashboard. New postings that fail them are stored
as "skipped by filter" (so the user can see what was dropped) and never opened.

- Category include list. Default: `Software` and `Software Engineering`.
- Location include/exclude by country, state, or city. Location strings look
  like `Seattle, WA`, `Toronto, ON, Canada`, `Remote in Canada`, `Remote in USA`.
  Country has to be worked out from these: US state codes → USA, Canadian
  province codes or "Canada" → Canada, etc. A posting with several locations
  passes if **any** location passes (Claude's call; the user can flip it to
  "all").
- Posted within N days. Default **14** (user's setting).
- Optional: company exclude list, title keywords to require or block, degree.
- Saving a filter shows a live count of how many current postings match.

### 4.3 The user's data

- **Resume PDF.** Uploaded to forms as-is. At setup, Claude reads it into a
  structured profile draft that the user confirms.
- **Profile (fixed facts).** Name, email, phone, address, LinkedIn, GitHub,
  website, school, degree, major, GPA, graduation date, work authorization,
  sponsorship need, willingness to relocate, start date availability, and
  demographic/EEO answers (gender, race/ethnicity, veteran, disability), each of
  which allows "decline to answer". These are never AI-guessed.
  The user's answers, to pre-fill the profile:
  - Work authorization: **U.S. citizen**. Sponsorship: **not needed now or in
    the future**. Any visa question: no visa required.
  - Ethnicity: **Hispanic/Latino**.
  - Veteran: **No**. Military spouse / protected veteran family: **No**.
  - Disability: **Prefer not to answer**.
  - Gender: **Male**. Sexual orientation: **Heterosexual/straight**.
    Pronouns: **he/him**.
- **Consent and signatures.** The app may tick required legal/consent boxes
  ("I certify this information is accurate", privacy/data consent,
  background-check consent) and type the user's full name as an e-signature
  (user approved). It never ticks optional SMS, marketing, or "talent
  community" opt-ins (Claude's call).
- **Answer bank.** Every other question the app has seen, with its answer.

### 4.4 Answering a question

For each field on a form, the app builds a description: label/question text,
field type (text, textarea, select, radio, checkbox, file, date, typeahead),
options if any, required or not, and which page it's on. It then decides what
to put there, in this order:

1. **Profile.** If the field asks for a fixed fact, use the profile value,
   converted to the field's format (e.g. "United States" vs "US" vs "USA" in a
   dropdown; a date in the format the field wants).
2. **Answer bank.** Look for a saved question with the same meaning, even if
   worded differently ("Are you legally authorized to work in the US?" ≈ "Do
   you have US work authorization?"). If there's a confident match, adapt the
   stored answer to this field (pick the matching dropdown option, trim to a
   character limit). The new wording is saved as another variant of that
   question.
3. **AI draft.** If it's an open question the resume and profile can answer
   (e.g. "Describe a project you're proud of"), Claude drafts an answer from the
   resume, profile, and existing bank. A draft is **not** sent the first time:
   it goes to the inbox for one-time approval. Once approved it's saved to the
   bank and reused freely.
4. **Missing input.** If none of the above works, or the question is factual
   and not covered by the profile/bank, the field is flagged "missing input".

Optional fields the app can't answer confidently are left blank, not guessed.

**Company-specific questions** (Claude's calls):
- "Why do you want to work at X?" and similar: the bank stores an approved
  **template**. Each time, the AI adapts it to the company and job description
  (from the posting page), and it's sent without asking again.
- "Have you worked at X before?" / "Have you applied to X before?": answered
  from the resume's employer list and the app's own records. "Are you related
  to an X employee?" is a global answer the user gives once.
- Location or term preference questions: the posting's location that passed
  the filters, and the posting's term.
- Shortening an approved answer to fit a character limit doesn't need approval
  again.

### 4.5 Inbox (the main screen)

Question-first, as in the chosen mockup:

- One card per unanswered question (grouped by meaning, not exact wording),
  showing how many jobs it's blocking and which ones.
- If there's an AI draft: **Use draft**, **Edit**, or **Tell AI what to
  change** (the user writes an instruction and the AI rewrites).
- If there's no draft: a field to type the answer, shaped to the question (a
  dropdown if the question had options).
- Answering saves to the answer bank and sends every job waiting on that
  question back into the queue.
- Other "needs you" items show up here too: a CAPTCHA, a verification code it
  couldn't find, a login that failed.
- **Time-sensitive items** (CAPTCHA, expiring code) (Claude's call): the
  runner keeps the browser open and waits up to ~10 minutes, sending a macOS
  notification. If nobody responds, the job is set aside as "needs you" and the
  queue moves on. A **Do it now** button re-runs that job in a visible browser
  and waits for the user at the blocking step.

### 4.6 Filling forms

- A **job runner** takes jobs from the queue and drives Chromium with
  Playwright. Visible browser by default so the user can watch; background mode
  is a setting. Runs one job at a time by default (Claude's call; configurable).
- **Application systems.** Each major system gets its own handler, which knows
  how to get to the form, read its fields reliably, deal with its custom
  widgets (Workday's dropdowns and typeaheads, multi-page "Next" flow, resume
  upload that pre-fills sections), and recognize the "submitted" confirmation.
  Priority by volume and difficulty: Greenhouse, Lever, Ashby (single page,
  easiest), then Workday (largest share), then Oracle Cloud, SmartRecruiters.
- **Generic handler** for everything else (company-built sites). It reads the
  page's form controls and accessibility tree, and Claude maps fields, finds the
  apply/next/submit buttons, and handles multi-step flows. Expect lower success
  here; failures must be clear and retryable.
- **Multi-page forms.** Later pages are only visible after earlier ones are
  done. The runner fills as far as it can, and when it reaches a page with
  unanswerable required fields it records them as missing input and stops. When
  those are answered, the job runs again from the start (Workday keeps a draft
  under the account, which helps).
- **"Apply with resume" pre-fill.** Many systems parse the uploaded resume and
  pre-fill fields. The runner must check pre-filled values against the profile
  and correct them, not trust them.

### 4.7 Accounts and verification

- Settings hold one email + password used for all portals.
- On a site that needs an account (Workday per company, Oracle, some others):
  try to sign in first. If the account doesn't exist, create it. Record per
  company/site that an account now exists.
- The user uses this same email + password on all their portal accounts, so
  existing accounts are expected to sign in fine. If sign-in fails and account
  creation says the account already exists, stop (no repeated attempts, to
  avoid lockouts) and flag it in the inbox. Never use "forgot password" or
  reset anything. Email + password only, no "Sign in with Google/LinkedIn"
  (Claude's call).
- **Verification codes/links:** read the inbox over IMAP (Gmail with an app
  password; Claude's call), look for the most recent message from that site
  after the request time, extract the code or link. If nothing arrives within a
  few minutes, flag it in the inbox.
- Credentials and the IMAP app password are stored in the macOS Keychain, not in
  plain files (Claude's call).

### 4.8 Submitting

- **Auto-submit (default):** once every required field is filled with profile
  data, bank answers, or approved drafts, submit.
- **Review mode** (setting: off / all jobs / specific companies): stop at
  "ready to review", show every field and its value next to a screenshot, let
  the user edit, then submit or skip.
- Never submit with a required field blank, a CAPTCHA in the way, or an
  unapproved AI draft in the answers.
- Optional daily limit on submissions (off by default).
- **Record for each submitted job:** screenshots of each page before moving on
  and of the confirmation, every field and value sent, the time, and the
  resume file used.

### 4.9 Job states

`new → skipped by filter` or `queued → filling → (needs you | ready to review |
submitted | failed | closed)`. "Needs you" goes back to `queued` when
resolved. "Failed" shows the reason and a screenshot and has a Retry button.
Jobs already applied to elsewhere (e.g. user applied by hand) can be marked
"applied manually".

### 4.10 Dashboard

A local web app (served on localhost) with tabs:
**Inbox · Applications · Answer bank · Profile & resume · Sources & filters ·
Settings.**

- Applications: list with status filter chips and counts, company/title/location,
  posted date, application system; open one to see its record.
- Answer bank: search, edit, delete; each entry shows its question variants and
  how many times it's been used.
- Settings: portal email/password, IMAP, Claude API key, auto-submit/review,
  daily limit, poll interval, visible/background browser.

## 5. Constraints

- Runs locally on macOS. Single user. Data stays on the machine except calls to
  the Claude API and the job sites themselves.
- TypeScript throughout; Playwright with Chromium.
- Needs an Anthropic API key from the user.
- Application sites change their pages, and some actively resist automation.
  Handlers have to fail loudly and be easy to update.

## 6. Left to the builder

- Web framework, database (SQLite expected), project layout, how the background
  runner and dashboard talk to each other.
- Which Claude models to use for which step, prompt design, and cost controls
  (e.g. caching answers to repeated field descriptions).
- How question matching works (embeddings, an LLM judge, or both) and its
  confidence thresholds, as long as wrong matches on factual questions are
  rare (a wrong match there should fall back to missing input).
- Selectors and handling for each application system.
- Test approach. Saved HTML snapshots of real forms per system are recommended
  for repeatable tests without submitting real applications.

## 7. What "working" looks like

1. With profile + resume set up, new Software postings outside Canada show up
   in the queue within one poll, without the user doing anything.
2. Greenhouse, Lever, and Ashby applications go from queued to submitted with
   no help once the bank covers their questions.
3. A Workday application goes end to end: account created (or signed in),
   email verification handled, all pages filled, submitted.
4. A question answered once in the inbox is never asked again, including when a
   different site words it differently.
5. Every job ends in a visible state; every failure has a reason and a
   screenshot.

## 8. Suggested build order (Claude's call)

1. Sources + filters + job database + bare dashboard (Applications, Sources &
   filters).
2. Profile/resume setup, answer bank, inbox.
3. Greenhouse, Lever, Ashby handlers with auto-submit and review mode.
4. Workday handler + accounts + email verification.
5. Oracle, SmartRecruiters, generic handler.

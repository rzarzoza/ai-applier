# AI Applier

A local app that watches internship listings and applies to the ones that match your filters (Greenhouse, Lever, Ashby for now). Everything runs on your machine; the dashboard binds to `127.0.0.1` only.

## Setup

```sh
pnpm i
pnpm exec playwright install chromium
pnpm start
```

Then open <http://127.0.0.1:4310>.

Your data (database, resume, browser profile, submission records) lives in `./data`. Set `AI_APPLIER_DATA=/some/dir` to use another folder. The Anthropic API key is stored in the macOS Keychain (enter it in Settings); if none is stored, the SDK's default credentials (e.g. `ANTHROPIC_API_KEY`) are used.

## First run

1. **Profile & resume** - upload your resume PDF; the profile is filled from it.
2. **Review the profile** - fix or complete any field the import missed.
3. **Sources & filters** - check the filter preview ("N of M current postings match") and adjust until it looks right.
4. **Watch the Inbox** - questions the app can't answer yet land there. Answer once; the answer is saved to the Answer bank and the waiting jobs are requeued.

## Review mode and pause

- **Review before submitting** (Settings): `Never` submits automatically; `Always` stops every job at *ready to review* with a screenshot and the filled fields, and you press Submit on the job's page; `Only for these companies` does that just for the companies you list.
- **Paused** (Settings): the runner takes no new jobs. Polling continues, and jobs you start by hand ("Do it now" in the Inbox, Submit on a reviewed job) still run.
- **Daily limit** caps submissions per day. Jobs run one at a time.

When unsure, start with Paused on or review mode `Always`.

## Browser extension

The extension fills applications you open in your own Chrome, using the app's profile and answer bank (the app must be running). On Greenhouse, Lever, Ashby, Workday, Oracle Cloud, SmartRecruiters, iCIMS, BambooHR and Workable pages it starts by itself once the form shows; on any other site click its icon, then **Fill this page**. A panel in the corner shows what was filled and lists what's left (click one to jump to it; drafts the app wrote wait for **Use suggestion**). It never submits and never fills passwords: when you click Submit, what you typed is saved to the answer bank (so the next form fills it, even when worded differently) and the application is recorded as submitted in the dashboard and the tracker.

1. **Build** - `pnpm build:ext` (writes `extension/dist/`; build again after pulling changes, then click the reload icon on the extension's card).
2. **Load it** - open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `extension/dist` folder.
3. **Pair it** - in the app open Settings → **Browser extension**, copy the token, click the extension's icon, open **Pairing**, paste it and click Save. (The app's address can be changed there too, e.g. when it runs with `AI_APPLIER_PORT`.)

Use **Pause on this site** in the panel (or the icon's menu) to keep it off a site.

## Commands

- `pnpm start` - run the app (polls on startup, then every *Poll every* minutes)
- `pnpm build:ext` - build the browser extension into `extension/dist/`
- `pnpm test` / `pnpm typecheck`

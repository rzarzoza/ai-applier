# AI Applier

Applies to internships for you. A local app keeps your profile, your answer bank (every question you've answered, reused even when a form words it differently) and a tracker of your applications. A Chrome extension fills application forms in your own browser from that data. An optional background applier can also work through the SimplifyJobs list on its own.

Everything runs on your Mac. The AI is a local model (Ollama + Qwen), so it costs nothing and nothing is sent to Anthropic unless you switch that on yourself. The dashboard is only reachable from your Mac (`127.0.0.1`).

> **Keep this folder out of iCloud.** It lives in `ai-applier.nosync`; the `.nosync` ending stops iCloud Drive from syncing it. If you ever see files named `something 2.ts`, iCloud made conflict copies: stop the app and delete them.

---

## 1. Install (once)

You need macOS on Apple Silicon (M1 or newer), [Homebrew](https://brew.sh), Node 24+, pnpm and Google Chrome.

```sh
brew install node pnpm ollama        # skip any you already have
cd ~/Documents/Proyectos/ai-applier.nosync
pnpm install
pnpm exec playwright install chromium   # only used as a fallback if Chrome is missing
pnpm build:ext                          # builds the Chrome extension into extension/dist
```

Download the AI model (about 9 GB, once):

```sh
ollama pull qwen2.5:14b
```

Smaller and about twice as fast, but a bit less accurate: `ollama pull qwen2.5:7b`. You choose the model in Settings.

---

## 2. Start it (every time)

Two things have to be running.

1. **Ollama**: open the Ollama app; its icon appears in the menu bar. Or run `ollama serve` in a Terminal window and leave it open.
2. **The app**:
   ```sh
   cd ~/Documents/Proyectos/ai-applier.nosync
   pnpm start
   ```
   Leave this Terminal window open, then open **<http://127.0.0.1:4310>**.

To stop the app, press **Ctrl-C** in its Terminal window.

---

## 3. Set it up (once)

In the dashboard:

1. **Profile**:
   - Upload your resume PDF. The app reads it and fills in your profile (this takes about half a minute).
   - Check every field, and fill in anything it missed: work authorization, sponsorship, demographics, graduation date and so on. These answers go on real applications.
2. **Settings → AI**:
   - It should say *"AI runs on your Mac (Ollama · qwen2.5:14b) — free"*.
   - Click **Test connection**. It should list your model. If it doesn't, Ollama isn't running.
   - Leave **"If the local model is off"** on **Leave the field for me**.
3. **Sources & filters**:
   - Set the countries you want. Pick **USA only** if you don't want London or other foreign roles.
   - Set the categories and how many days back to look.
   - The preview shows how many postings match.
4. **Settings → Review before submitting**: leave it on **Always** until you trust it. This only affects the background applier.

Then install the Chrome extension.

5. Open `chrome://extensions` in Chrome and turn on **Developer mode** (top right).
6. Click **Load unpacked** and choose the folder `~/Documents/Proyectos/ai-applier.nosync/extension/dist`.
7. Pin the extension: click the puzzle-piece icon in the toolbar, then the pin next to **AI Applier**.
8. Pair it with the app:
   1. In the dashboard, open **Settings → Browser extension** and click **Copy**.
   2. Click the extension's icon and open **Pairing**.
   3. Paste the code and click **Save**. It should say *"Connected · profile ready"*.

---

## 4. Use it

### Applying with the extension (the main way)

1. Make sure Ollama and the app are running (step 2).
2. Open an application in Chrome. Use **View posting** on a job's page in the dashboard, or any posting on Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Oracle, iCIMS, BambooHR or Workable.
3. The **AI Applier** panel appears in the corner and fills in the form:
   - **Green** outline: filled from your profile or answer bank.
   - **Orange** outline: left for you. The panel lists these with the form's exact question. Click one to jump to it.
   - **Use suggestion**: an answer the app drafted from your resume or profile. Check it before using it.
   - If a dropdown didn't match, the panel shows the top choices; click one.
4. Finish the orange fields, solve any CAPTCHA, check everything, and click the site's **Submit** yourself. The extension never submits.
5. When you submit:
   - what you typed is saved to your answer bank, so the next form fills it automatically, even when it's worded differently;
   - the application is recorded as **Submitted** in the dashboard and in your tracker.

**Notes:**
- **Pages that don't auto-start**: on a site the extension doesn't start on by itself, click its icon, then **Fill this page**.
- **Workday**: sign in yourself, and click **Next** on each step yourself. The extension fills each step as it appears.
- **Pausing on a site**: **Pause on this site** in the panel turns the extension off there.
- **First time on a new kind of form**: the local model can take a few minutes to work out a brand-new form. Fields it has seen before fill instantly.

### The dashboard

| Page | What it's for |
|---|---|
| **Home** | What's waiting on you, what's ready to review, what's queued, what you've submitted, and today's AI spend (should stay at $0.00). |
| **Inbox** | Questions the app couldn't answer, with the form's exact wording. Answer once and every job asking the same thing moves forward. **Approve all profile-based suggestions** approves the answers it took straight from your profile in one go. |
| **Applications** | Every job and its status. Open one to see its screenshot and filled fields, and to review, submit, retry or skip it. |
| **Answer bank** | Everything it has learned. Edit or delete any answer. |
| **Tracker** | `data/applications.csv` lists every submitted application: date, company, title, link, resume and cover letter used. Open it in Excel, Numbers or Google Sheets, or link a Google Sheet in Settings. |

### Background applier (optional)

It's off by default. When it's on, the app works through the queued SimplifyJobs postings by itself in its own Chrome window:
- With review mode **Always**, every filled application stops at **Ready to review**.
- Questions it can't answer go to the Inbox.
- Turn it on or off on **Home**.
- The **Pause** button in the top bar stops it at any time.

---

## Updating

After pulling new code:

1. Stop the app (**Ctrl-C**).
2. Run these:
   ```sh
   pnpm install
   pnpm build:ext
   pnpm start
   ```
3. In `chrome://extensions`, click the **reload** icon on AI Applier, then refresh any open application pages.

You don't need to pair again.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| The panel says the app isn't reachable | Start the app with `pnpm start`. In the extension's **Pairing** section, check the address is `http://127.0.0.1:4310`. |
| Fields stay orange and Settings → AI → Test connection fails | Ollama isn't running. Open the Ollama app or run `ollama serve`. |
| The extension doesn't appear on a page | Click its icon and choose **Fill this page**. If it says no form was found, refresh after the form has loaded. |
| "AI budget reached" | Only applies if you switched a task to Claude in Settings → AI. Raise the budget or switch back to Local. |
| A wrong value was filled | Fix it on the page before submitting. To fix it for future forms too, change the answer in **Answer bank** or **Profile**. |
| Files named `… 2.ts` appeared | That's iCloud. Make sure the folder name still ends in `.nosync`, stop the app and delete the copies. |

## Where things are stored

Your database, resume, browser profile, screenshots and `applications.csv` are in `./data`. Set `AI_APPLIER_DATA=/some/dir` to use a different folder. Any keys you enter (Claude, Google Sheets) are stored in the macOS Keychain, never in files.

## Commands

- `pnpm start`: run the app on <http://127.0.0.1:4310> (set `AI_APPLIER_PORT` to change the port)
- `pnpm build:ext`: build the Chrome extension into `extension/dist/`
- `pnpm test` / `pnpm typecheck`: run the checks

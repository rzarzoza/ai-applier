import { afterEach, expect, test } from "vitest";
import { upsertPosting } from "../../src/jobs/repo.js";
import { getSettings } from "../../src/settings.js";
import { startFakeOllama } from "../helpers/fake-ollama.js";
import { form, setupApp } from "./helpers.js";

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

const usage = (db: ReturnType<typeof setupApp>["db"], row: { task: string; provider: string; model: string; cost: number; jobId?: string }) =>
  db.prepare("INSERT INTO llm_usage (at, task, provider, model, input_tokens, output_tokens, cache_read, cost_usd, job_id) VALUES (?, ?, ?, ?, 1000, 100, 0, ?, ?)")
    .run(new Date().toISOString(), row.task, row.provider, row.model, row.cost, row.jobId ?? null);

test("the AI card says everything runs locally for free by default, with today's and the week's breakdown", async () => {
  const { app, db } = setupApp();
  usage(db, { task: "classify", provider: "ollama", model: "qwen2.5:14b", cost: 0 });
  const html = await (await app.request("/settings")).text();
  expect(html).toContain("AI runs on your Mac (Ollama · qwen2.5:14b) — free");
  expect(html).toContain('name="aiFast"');
  expect(html).toContain("Leave the field for me");
  expect(html).toContain("Test connection");
  expect(html).toContain("Last 7 days");
  expect(html).toContain("Classify fields");
  expect(html).toContain("AI spend today: $0.00 · 1 call");
});

test("saving the AI card stores the providers, the Ollama address and model, the fallback and the budget", async () => {
  const { app, db } = setupApp();
  const res = await app.request("/settings/ai", form({
    aiFast: "local", aiWrite: "claude", ollamaUrl: "http://127.0.0.1:11500/", ollamaModel: "llama3:8b", aiLocalOff: "claude", aiDailyBudgetUsd: "$2.5",
  }));
  expect(res.status).toBe(303);
  expect(getSettings(db)).toMatchObject({ aiFast: "local", aiWrite: "claude", ollamaUrl: "http://127.0.0.1:11500", ollamaModel: "llama3:8b", aiLocalOff: "claude", aiDailyBudgetUsd: 2.5 });
  expect(await (await app.request("/settings")).text()).toContain("Claude spend today");
  expect((await app.request("/settings/ai", form({ aiFast: "opus", aiWrite: "local" }))).status).toBe(400);
  expect((await app.request("/settings/ai", form({ aiFast: "local", aiWrite: "local", aiDailyBudgetUsd: "-1" }))).status).toBe(400);
});

test("Test connection lists the models Ollama has, and says when the chosen one is missing", async () => {
  const fake = await startFakeOllama({ models: ["qwen2.5:14b", "llama3:8b"] });
  close = fake.close;
  const { app } = setupApp();
  const ok = await (await app.request("/settings/ai/test", form({ ollamaUrl: fake.url, ollamaModel: "qwen2.5:14b" }))).text();
  expect(ok).toContain("Installed: qwen2.5:14b, llama3:8b");
  expect(ok).toContain("qwen2.5:14b is ready");
  const missing = await (await app.request("/settings/ai/test", form({ ollamaUrl: fake.url, ollamaModel: "mistral" }))).text();
  expect(missing).toContain("ollama pull mistral");
  const down = await (await app.request("/settings/ai/test", form({ ollamaUrl: "http://127.0.0.1:9", ollamaModel: "x" }))).text();
  expect(down).toContain("Couldn&#39;t reach Ollama");
});

test("the job page shows what the AI cost for that application", async () => {
  const { app, db } = setupApp();
  const { job } = upsertPosting(db, { sourceId: "s", listingId: "1", company: "Acme", title: "Intern", locations: ["NYC"], category: null,
    terms: [], degrees: [], sponsorship: null, url: "https://acme.test/1", datePosted: new Date(), active: true });
  usage(db, { task: "draft", provider: "claude", model: "claude-sonnet-5-5", cost: 0.012, jobId: job.id });
  usage(db, { task: "classify", provider: "ollama", model: "qwen2.5:14b", cost: 0, jobId: job.id });
  usage(db, { task: "draft", provider: "claude", model: "claude-sonnet-5-5", cost: 0.5, jobId: "another" });
  const html = await (await app.request(`/applications/${job.id}`)).text();
  expect(html).toContain("AI cost: $0.01 · 2 calls");
});

test("once Claude is in use and today's budget is spent, every page says so", async () => {
  const { app, db } = setupApp();
  usage(db, { task: "draft", provider: "claude", model: "claude-sonnet-5-5", cost: 1.2 });
  // Everything local (the default): the budget doesn't apply.
  expect(await (await app.request("/")).text()).not.toContain("AI budget reached for today");
  await app.request("/settings/ai", form({ aiFast: "local", aiWrite: "claude", aiLocalOff: "leave", aiDailyBudgetUsd: "1" }));
  const html = await (await app.request("/inbox")).text();
  expect(html).toContain("AI budget reached for today");
  expect(html).toContain("AI spend today: $1.20 · 1 call");
});

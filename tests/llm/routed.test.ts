import { describe, expect, test } from "vitest";
import { z } from "zod";
import { openDb, type Db } from "../../src/db/db.js";
import { LlmBudgetError, LlmOutputError, LlmUnavailableError, type Provider, type StructuredRequest, type Usage } from "../../src/llm/llm.js";
import { claudeSpendToday, costUsd, spendByTask, spendForJob, spendToday, startOfDay, withAiScope } from "../../src/llm/meter.js";
import { BUDGET_NOTICE, RoutedLlm } from "../../src/llm/routed.js";
import { saveSettings } from "../../src/settings.js";

const Schema = z.object({ ok: z.boolean() });
const ask = (name: string, extra: Partial<StructuredRequest<{ ok: boolean }>> = {}): StructuredRequest<{ ok: boolean }> =>
  ({ name, schema: Schema, system: "s", content: "c", effort: "high", ...extra });

type Fake = Provider & { calls: StructuredRequest<unknown>[]; model: string };

function fakeProvider(kind: "claude" | "ollama", model: string, usage: Partial<Usage> = {}, fail?: Error): Fake {
  const calls: StructuredRequest<unknown>[] = [];
  return {
    kind, model, calls,
    async run<T>(req: StructuredRequest<T>) {
      calls.push(req as StructuredRequest<unknown>);
      if (fail) throw fail;
      return { value: { ok: true } as T, usage: { model, inputTokens: 1000, outputTokens: 200, cacheRead: 0, cacheWrite: 0, ...usage } };
    },
  };
}

function setup(opts: { localFails?: Error; claudeUsage?: Partial<Usage> } = {}) {
  const db: Db = openDb(":memory:");
  const local = fakeProvider("ollama", "qwen2.5:14b", {}, opts.localFails);
  const claude = new Map<string, Fake>();
  const llm = new RoutedLlm({
    db,
    ollama: () => local,
    claude: model => { const p = claude.get(model) ?? fakeProvider("claude", model, opts.claudeUsage); claude.set(model, p); return p; },
  });
  const claudeCalls = () => [...claude.values()].reduce((n, p) => n + p.calls.length, 0);
  return { db, llm, local, claude, claudeCalls };
}

describe("RoutedLlm routing", () => {
  test("by default every task (fast and write) runs on the local model; Claude is never built", async () => {
    const { llm, local, claude } = setup();
    for (const name of ["classify", "match", "adapt", "variants", "fact", "draft", "revise", "template", "resume"]) await llm.structured(ask(name));
    expect(local.calls.map(c => c.name)).toHaveLength(9);
    expect(claude.size).toBe(0);
  });

  test("a category set to Claude uses Haiku for fast tasks (low effort) and Sonnet for writing (medium effort), never Opus", async () => {
    const { db, llm, local, claude } = setup();
    saveSettings(db, { aiFast: "claude", aiWrite: "claude" });
    await llm.structured(ask("classify"));
    await llm.structured(ask("draft"));
    expect(local.calls).toHaveLength(0);
    expect([...claude.keys()]).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(claude.get("claude-haiku-5-5")!.calls[0]!.effort).toBe("low");
    expect(claude.get("claude-sonnet-5-5")!.calls[0]!.effort).toBe("medium");
    expect([...claude.keys()].some(m => m.includes("opus"))).toBe(false);
  });

  test("mixed: fast tasks local, writing on Claude", async () => {
    const { db, llm, local, claude } = setup();
    saveSettings(db, { aiFast: "local", aiWrite: "claude" });
    await llm.structured(ask("match"));
    await llm.structured(ask("template"));
    expect(local.calls.map(c => c.name)).toEqual(["match"]);
    expect([...claude.keys()]).toEqual(["claude-sonnet-5-5"]);
  });

  test("local model off + 'Leave the field for me' (the default): the error stands and Claude is not called", async () => {
    const { llm, claudeCalls } = setup({ localFails: new LlmUnavailableError("The local model isn't running") });
    await expect(llm.structured(ask("adapt"))).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(claudeCalls()).toBe(0);
  });

  test("local model off + 'Use Claude': the request goes to Claude (the category's model)", async () => {
    const { db, llm, claude } = setup({ localFails: new LlmUnavailableError("off") });
    saveSettings(db, { aiLocalOff: "claude" });
    expect(await llm.structured(ask("draft"))).toEqual({ ok: true });
    expect([...claude.keys()]).toEqual(["claude-sonnet-5-5"]);
  });

  test("an unusable local answer is not a reason to call Claude", async () => {
    const { db, llm, claudeCalls } = setup({ localFails: new LlmOutputError("bad") });
    saveSettings(db, { aiLocalOff: "claude" });
    await expect(llm.structured(ask("adapt"))).rejects.toBeInstanceOf(LlmOutputError);
    expect(claudeCalls()).toBe(0);
  });
});

describe("usage meter", () => {
  test("cost math: Haiku $0.10/$0.50, Sonnet $2/$10 per MTok (cache reads 10% / $0.20), Ollama free", () => {
    const u = (model: string, i: number, o: number, r = 0): Usage => ({ model, inputTokens: i, outputTokens: o, cacheRead: r, cacheWrite: 0 });
    expect(costUsd("claude", u("claude-haiku-5-5", 1_000_000, 1_000_000, 1_000_000))).toBeCloseTo(0.10 + 0.50 + 0.01, 10);
    expect(costUsd("claude", u("claude-sonnet-5-5", 1_000_000, 1_000_000, 1_000_000))).toBeCloseTo(2 + 10 + 0.20, 10);
    expect(costUsd("claude", u("claude-sonnet-5-5", 2000, 500))).toBeCloseTo(0.004 + 0.005, 10);
    expect(costUsd("claude", { ...u("claude-sonnet-5-5", 0, 0), cacheWrite: 1_000_000 })).toBeCloseTo(2.5, 10);
    expect(costUsd("ollama", u("qwen2.5:14b", 1_000_000, 1_000_000))).toBe(0);
  });

  test("every call records a row (task, provider, model, tokens, cost) and the job it was for", async () => {
    const { db, llm } = setup({ claudeUsage: { inputTokens: 2000, outputTokens: 500, cacheRead: 1000 } });
    saveSettings(db, { aiWrite: "claude" });
    await withAiScope("job-1", async () => {
      await llm.structured(ask("classify"));
      await llm.structured(ask("draft"));
    });
    const rows = db.prepare("SELECT task, provider, model, input_tokens, output_tokens, cache_read, cost_usd, job_id FROM llm_usage ORDER BY id").all();
    expect(rows).toEqual([
      { task: "classify", provider: "ollama", model: "qwen2.5:14b", input_tokens: 1000, output_tokens: 200, cache_read: 0, cost_usd: 0, job_id: "job-1" },
      { task: "draft", provider: "claude", model: "claude-sonnet-5-5", input_tokens: 2000, output_tokens: 500, cache_read: 1000, cost_usd: expect.closeTo(0.0092, 10), job_id: "job-1" },
    ]);
    expect(spendToday(db)).toEqual({ costUsd: expect.closeTo(0.0092, 10), calls: 2 });
    expect(spendForJob(db, "job-1").calls).toBe(2);
    expect(spendByTask(db, startOfDay()).map(r => [r.task, r.calls, r.local])).toEqual([["draft", 1, 0], ["classify", 1, 1]]);
  });

  test("a refused or unusable Claude answer is still metered (it was paid for)", async () => {
    const { db, llm } = setup();
    saveSettings(db, { aiFast: "claude" });
    const failing: Provider = { kind: "claude", run: async () => { throw new LlmOutputError("no output", { model: "claude-haiku-5-5", inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0 }); } };
    const llm2 = new RoutedLlm({ db, claude: () => failing, ollama: () => { throw new Error("unused"); } });
    await expect(llm2.structured(ask("classify"))).rejects.toBeInstanceOf(LlmOutputError);
    expect(claudeSpendToday(db)).toBeGreaterThan(0);
    void llm;
  });
});

describe("daily budget", () => {
  test("once today's Claude spend reaches the budget, Claude calls throw LlmBudgetError and nothing is sent", async () => {
    // Each Sonnet call: 50k in + 10k out = $0.10 + $0.10 = $0.20.
    const { db, llm, claude } = setup({ claudeUsage: { inputTokens: 50_000, outputTokens: 10_000 } });
    saveSettings(db, { aiWrite: "claude", aiDailyBudgetUsd: 0.5 });
    await llm.structured(ask("draft"));
    await llm.structured(ask("draft"));
    await llm.structured(ask("draft")); // $0.40 before this one: allowed, ends at $0.60
    const { notices } = await withAiScope(undefined, async () => {
      await expect(llm.structured(ask("draft"))).rejects.toBeInstanceOf(LlmBudgetError);
    });
    expect(notices).toEqual([BUDGET_NOTICE]);
    expect(claude.get("claude-sonnet-5-5")!.calls).toHaveLength(3);
  });

  test("local calls are never capped", async () => {
    const { db, llm, local } = setup();
    saveSettings(db, { aiDailyBudgetUsd: 0 });
    await llm.structured(ask("draft"));
    expect(local.calls).toHaveLength(1);
  });

  test("yesterday's spend doesn't count", async () => {
    const { db, llm, claude } = setup();
    saveSettings(db, { aiFast: "claude", aiDailyBudgetUsd: 1 });
    const yesterday = new Date(new Date(startOfDay()).getTime() - 3600_000).toISOString();
    db.prepare("INSERT INTO llm_usage (at, task, provider, model, input_tokens, output_tokens, cache_read, cost_usd) VALUES (?, 'draft', 'claude', 'claude-sonnet-5-5', 0, 0, 0, 5)").run(yesterday);
    await llm.structured(ask("match"));
    expect(claude.get("claude-haiku-5-5")!.calls).toHaveLength(1);
  });
});

describe("cache", () => {
  test("a request with a cacheKey is answered from the cache the second time", async () => {
    const { llm, local } = setup();
    expect(await llm.structured(ask("adapt", { cacheKey: "adapt:k1" }))).toEqual({ ok: true });
    expect(await llm.structured(ask("adapt", { cacheKey: "adapt:k1" }))).toEqual({ ok: true });
    expect(local.calls).toHaveLength(1);
    await llm.structured(ask("adapt", { cacheKey: "adapt:k2" }));
    expect(local.calls).toHaveLength(2);
  });

  test("a failed request is not cached", async () => {
    const { llm, local } = setup({ localFails: new LlmUnavailableError("off") });
    await expect(llm.structured(ask("adapt", { cacheKey: "adapt:k" }))).rejects.toThrow();
    await expect(llm.structured(ask("adapt", { cacheKey: "adapt:k" }))).rejects.toThrow();
    expect(local.calls).toHaveLength(2);
  });
});

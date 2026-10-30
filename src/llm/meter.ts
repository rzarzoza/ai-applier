import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "../db/db.js";
import type { Usage } from "./llm.js";

/** US dollars per million tokens. Cache writes cost 1.25x input. */
interface Price { input: number; output: number; cacheRead: number; cacheWrite: number }

const price = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

/** By model id prefix. Opus is listed only to price a server-side refusal fallback that ran on it. */
const PRICES: [string, Price][] = [
  ["claude-haiku-5-5", price(0.10, 0.50, 0.01)],
  ["claude-sonnet-5-5", price(2, 10, 0.20)],
  ["claude-opus-5-5", price(4, 20, 0.40)],
];
/** An unknown Claude model is priced as Sonnet (never as free). */
const UNKNOWN_CLAUDE = price(2, 10, 0.20);

export function costUsd(provider: "claude" | "ollama", u: Usage): number {
  if (provider === "ollama") return 0;
  const p = PRICES.find(([prefix]) => u.model.startsWith(prefix))?.[1] ?? UNKNOWN_CLAUDE;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000;
}

/** What a run of the app is doing while it calls the LLM: the job it is for, and why the AI couldn't answer. */
export interface AiScope { jobId?: string; notices: Set<string> }

const scope = new AsyncLocalStorage<AiScope>();

/** Runs `fn` with its LLM calls metered against `jobId`; returns its result and why the AI couldn't answer (if it couldn't). */
export async function withAiScope<T>(jobId: string | undefined, fn: () => Promise<T>): Promise<{ result: T; notices: string[] }> {
  const s: AiScope = { jobId, notices: new Set() };
  const result = await scope.run(s, fn);
  return { result, notices: [...s.notices] };
}

export const currentAiScope = (): AiScope | undefined => scope.getStore();

export interface UsageRow {
  at: string; task: string; provider: "claude" | "ollama"; model: string;
  inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number; jobId: string | null;
}

export function recordUsage(db: Db, task: string, provider: "claude" | "ollama", u: Usage, now: Date = new Date()): UsageRow {
  const row: UsageRow = {
    at: now.toISOString(), task, provider, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens,
    cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, costUsd: costUsd(provider, u), jobId: currentAiScope()?.jobId ?? null,
  };
  db.prepare(`INSERT INTO llm_usage (at, task, provider, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, job_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.at, row.task, row.provider, row.model, row.inputTokens, row.outputTokens, row.cacheRead, row.cacheWrite, row.costUsd, row.jobId);
  return row;
}

/** Midnight (local time) of `now`'s day, as an ISO timestamp: "today" is the user's day. */
export function startOfDay(now: Date = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Claude spend since local midnight, in US dollars (local calls are free and never count). */
export function claudeSpendToday(db: Db, now: Date = new Date()): number {
  const r = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM llm_usage WHERE provider = 'claude' AND at >= ?").get(startOfDay(now)) as { c: number };
  return r.c;
}

export interface Spend { costUsd: number; calls: number }

/** All AI calls since local midnight (local ones too) and what they cost. */
export function spendToday(db: Db, now: Date = new Date()): Spend {
  const r = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n FROM llm_usage WHERE at >= ?").get(startOfDay(now)) as { c: number; n: number };
  return { costUsd: r.c, calls: r.n };
}

export interface TaskSpend { task: string; calls: number; local: number; costUsd: number; inputTokens: number; outputTokens: number }

/** Calls and cost by task since `sinceIso`, costliest first. */
export function spendByTask(db: Db, sinceIso: string): TaskSpend[] {
  const rows = db.prepare(`SELECT task, COUNT(*) AS calls, SUM(provider = 'ollama') AS local, COALESCE(SUM(cost_usd), 0) AS cost,
      SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM llm_usage WHERE at >= ? GROUP BY task ORDER BY cost DESC, calls DESC, task`)
    .all(sinceIso) as { task: string; calls: number; local: number; cost: number; input: number; output: number }[];
  return rows.map(r => ({ task: r.task, calls: r.calls, local: r.local, costUsd: r.cost, inputTokens: r.input, outputTokens: r.output }));
}

/** Midnight (local time) `days - 1` days before today: the start of the last `days` days, today included. */
export function startOfDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.toISOString();
}

/** What the AI cost for one application, over every run and the extension. */
export function spendForJob(db: Db, jobId: string): Spend {
  const r = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n FROM llm_usage WHERE job_id = ?").get(jobId) as { c: number; n: number };
  return { costUsd: r.c, calls: r.n };
}

/** "$0.04", or "$0.0012" for spend under a cent (so a few Haiku calls don't read as free). */
export function formatUsd(v: number): string {
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

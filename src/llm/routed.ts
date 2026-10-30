import type { Db } from "../db/db.js";
import { getSettings, type Settings } from "../settings.js";
import {
  CLAUDE_FAST_MODEL, CLAUDE_WRITE_MODEL, LlmBudgetError, LlmUnavailableError, isSoftLlmError, type Llm, type Provider, type StructuredRequest, type Usage,
} from "./llm.js";
import { claudeSpendToday, currentAiScope, formatUsd, recordUsage } from "./meter.js";
import { OllamaLlm } from "./ollama.js";

export type TaskCategory = "fast" | "write";

/** Short, mechanical tasks ("fast") and tasks that write prose for the applicant ("write"). Unknown names are fast. */
export const TASK_CATEGORY: Record<string, TaskCategory> = {
  classify: "fast", match: "fast", adapt: "fast", variants: "fast", fact: "fast",
  draft: "write", revise: "write", template: "write", resume: "write",
};
export const categoryOf = (task: string): TaskCategory => TASK_CATEGORY[task] ?? "fast";

const CLAUDE_MODEL: Record<TaskCategory, string> = { fast: CLAUDE_FAST_MODEL, write: CLAUDE_WRITE_MODEL };
const EFFORT: Record<TaskCategory, StructuredRequest<unknown>["effort"]> = { fast: "low", write: "medium" };

export const BUDGET_NOTICE = "AI budget reached for today";

/** Whether any request may go to Claude with these settings (a category set to Claude, or Claude standing in for the local model). */
export const claudeInUse = (s: Settings): boolean => s.aiFast === "claude" || s.aiWrite === "claude" || s.aiLocalOff === "claude";

/** Whether today's Claude budget is spent (only meaningful when Claude is in use). */
export const budgetReached = (db: Db, now: Date = new Date()): boolean =>
  claudeSpendToday(db, now) >= getSettings(db).aiDailyBudgetUsd;

export interface RoutedDeps {
  db: Db;
  /** A Claude model with the current API key. Only called when a request is actually sent to Claude. */
  claude(model: string): Provider;
  /** The local model; defaults to Ollama at the configured URL. */
  ollama?(baseUrl: string, model: string): Provider;
  now?(): Date;
}

/**
 * Sends each request to the model its task category is set to in Settings (the local Ollama model or Claude: Haiku for
 * fast tasks, Sonnet for writing; never Opus), meters every call, enforces the daily Claude budget, and answers requests
 * that carry a `cacheKey` from the cache when it can.
 *
 * When the local model is unavailable, the request goes to Claude only if Settings say so ("Use Claude"); otherwise the
 * LlmUnavailableError stands and the caller leaves the field for the user. Claude over budget throws LlmBudgetError.
 */
export class RoutedLlm implements Llm {
  constructor(private readonly deps: RoutedDeps) {}

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const { db } = this.deps;
    const cached = req.cacheKey ? getCached(db, req.cacheKey) : undefined;
    if (cached !== undefined) {
      const parsed = req.schema.safeParse(cached);
      if (parsed.success) return parsed.data;
    }
    try {
      const value = await this.route(req);
      if (req.cacheKey) putCached(db, req.cacheKey, req.name, value, this.now());
      return value;
    } catch (err) {
      if (isSoftLlmError(err)) currentAiScope()?.notices.add(err instanceof LlmBudgetError ? BUDGET_NOTICE : (err as Error).message);
      throw err;
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async route<T>(req: StructuredRequest<T>): Promise<T> {
    const s = getSettings(this.deps.db);
    const category = categoryOf(req.name);
    const sized = { ...req, effort: EFFORT[category] };
    if ((category === "fast" ? s.aiFast : s.aiWrite) === "claude") return this.viaClaude(sized, category, s);
    try {
      return await this.call(this.ollama(s), sized);
    } catch (err) {
      if (err instanceof LlmUnavailableError && s.aiLocalOff === "claude") return this.viaClaude(sized, category, s);
      throw err;
    }
  }

  private ollama(s: Settings): Provider {
    return this.deps.ollama?.(s.ollamaUrl, s.ollamaModel) ?? new OllamaLlm({ baseUrl: s.ollamaUrl, model: s.ollamaModel });
  }

  private async viaClaude<T>(req: StructuredRequest<T>, category: TaskCategory, s: Settings): Promise<T> {
    const spent = claudeSpendToday(this.deps.db, this.now());
    if (spent >= s.aiDailyBudgetUsd) {
      throw new LlmBudgetError(`${BUDGET_NOTICE} (${formatUsd(spent)} of ${formatUsd(s.aiDailyBudgetUsd)})`);
    }
    return this.call(this.deps.claude(CLAUDE_MODEL[category]), req);
  }

  /** Runs the request on one provider and meters it (a refused or unusable answer was still paid for). */
  private async call<T>(provider: Provider, req: StructuredRequest<T>): Promise<T> {
    try {
      const { value, usage } = await provider.run(req);
      recordUsage(this.deps.db, req.name, provider.kind, usage, this.now());
      return value;
    } catch (err) {
      const usage = (err as { usage?: Usage }).usage;
      if (usage) recordUsage(this.deps.db, req.name, provider.kind, usage, this.now());
      throw err;
    }
  }
}

function getCached(db: Db, key: string): unknown {
  const row = db.prepare("SELECT value_json FROM llm_cache WHERE key = ?").get(key) as { value_json: string } | undefined;
  return row ? JSON.parse(row.value_json) as unknown : undefined;
}

function putCached(db: Db, key: string, task: string, value: unknown, now: Date): void {
  db.prepare("INSERT OR REPLACE INTO llm_cache (key, task, value_json, created_at) VALUES (?, ?, ?, ?)").run(key, task, JSON.stringify(value), now.toISOString());
}

/** A cached LLM answer kept by a caller that manages its own cache keys (answers/match.ts). */
export const readLlmCache = getCached;
export const writeLlmCache = (db: Db, key: string, task: string, value: unknown) => putCached(db, key, task, value, new Date());

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export interface StructuredRequest<T> {
  /** Stable label ("classify", "match", ...) used by the fake, in logs, to route the request and to meter it. */
  name: string;
  schema: z.ZodType<T>;
  system: string;
  cachedContext?: string;
  content: string | Anthropic.Beta.BetaContentBlockParam[];
  effort: "low" | "medium" | "high";
  maxTokens?: number;
  /**
   * When set, a valid answer is kept under this key and returned for any later request with the same key without
   * calling a model (see llm/routed.ts). The caller picks a key that captures everything the answer depends on.
   */
  cacheKey?: string;
}

export interface Llm {
  structured<T>(req: StructuredRequest<T>): Promise<T>;
}

/** What one model call used, for the usage meter (llm/meter.ts). Output tokens include thinking. */
export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A model behind the router: answers a request and says what it used. */
export interface Provider {
  readonly kind: "claude" | "ollama";
  run<T>(req: StructuredRequest<T>): Promise<{ value: T; usage: Usage }>;
}

export class LlmRefusalError extends Error {
  constructor(message: string, readonly usage?: Usage) { super(message); }
}
export class LlmOutputError extends Error {
  constructor(message: string, readonly usage?: Usage) { super(message); }
}
/** No model can answer right now (the local model is off or missing, ...): the field is left for the user. */
export class LlmUnavailableError extends Error {}
/** Today's Claude budget is spent: treated like an unavailable model until tomorrow. */
export class LlmBudgetError extends LlmUnavailableError {}

/** An LLM failure that means "no answer from the AI" for one request: the caller leaves the field for the user. */
export const isSoftLlmError = (err: unknown): boolean => err instanceof LlmUnavailableError || err instanceof LlmOutputError;

/** The request's answer, or null when the AI could not give one (unavailable, over budget, unusable output). */
export async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (isSoftLlmError(err)) return null;
    throw err;
  }
}

/**
 * Why an LLM error means no job can run right now (a missing or rejected key, rate limits, the API
 * being unreachable or overloaded), or null when the error belongs to the one request.
 */
export function llmHaltReason(err: unknown): string | null {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key — check it in Settings";
  if (err instanceof Anthropic.PermissionDeniedError) return "Anthropic denied access for this API key";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limit reached — try again later";
  if (err instanceof Anthropic.APIConnectionError) return "Can't reach the Anthropic API — check your connection";
  if (err instanceof Anthropic.InternalServerError) return "The Anthropic API is unavailable or overloaded — try again later";
  if (err instanceof Error && /could not resolve authentication method/i.test(err.message)) return "Add your Anthropic API key in Settings";
  return null;
}

/** The Claude models the app may use: never Opus. */
export const CLAUDE_FAST_MODEL = "claude-haiku-5-5";
export const CLAUDE_WRITE_MODEL = "claude-sonnet-5-5";

/**
 * Server-side refusal fallbacks ("default" form) are documented for Claude Sonnet 5.5 on the Claude API; Claude Haiku
 * 5.5 has none, so its requests carry neither the parameter nor its beta header.
 */
const FALLBACK_MODELS = new Set([CLAUDE_WRITE_MODEL]);

export class ClaudeLlm implements Llm, Provider {
  readonly kind = "claude" as const;
  private client: Anthropic;
  readonly model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? CLAUDE_WRITE_MODEL;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    return (await this.run(req)).value;
  }

  async run<T>(req: StructuredRequest<T>): Promise<{ value: T; usage: Usage }> {
    const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: req.system }];
    if (req.cachedContext) {
      system.push({
        type: "text",
        text: req.cachedContext,
        cache_control: { type: "ephemeral" },
      });
    }
    const fallback = FALLBACK_MODELS.has(this.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {};
    const res = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      ...fallback,
      output_config: { effort: req.effort, format: zodOutputFormat(req.schema) },
      system,
      messages: [{ role: "user", content: req.content }],
    });
    const usage: Usage = {
      model: res.model || this.model,
      inputTokens: res.usage.input_tokens ?? 0,
      outputTokens: res.usage.output_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
      cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
    };
    if (res.stop_reason === "refusal") {
      throw new LlmRefusalError(`Claude refused request "${req.name}"`, usage);
    }
    if (res.parsed_output == null) {
      throw new LlmOutputError(`No parsed output for "${req.name}" (stop_reason=${res.stop_reason})`, usage);
    }
    return { value: res.parsed_output as T, usage };
  }
}

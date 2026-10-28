import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export interface StructuredRequest<T> {
  /** Stable label ("classify", "match", ...) used by the fake and in logs. */
  name: string;
  schema: z.ZodType<T>;
  system: string;
  cachedContext?: string;
  content: string | Anthropic.Beta.BetaContentBlockParam[];
  effort: "low" | "medium" | "high";
  maxTokens?: number;
}

export interface Llm {
  structured<T>(req: StructuredRequest<T>): Promise<T>;
}

export class LlmRefusalError extends Error {}

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
export class LlmOutputError extends Error {}

const MODEL = "claude-opus-5-5";

export class ClaudeLlm implements Llm {
  private client: Anthropic;

  constructor(opts: { apiKey?: string } = {}) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: req.system }];
    if (req.cachedContext) {
      system.push({
        type: "text",
        text: req.cachedContext,
        cache_control: { type: "ephemeral" },
      });
    }
    const res = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: req.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: req.effort, format: zodOutputFormat(req.schema) },
      system,
      messages: [{ role: "user", content: req.content }],
    });
    if (res.stop_reason === "refusal") {
      throw new LlmRefusalError(`Claude refused request "${req.name}"`);
    }
    if (res.parsed_output == null) {
      throw new LlmOutputError(
        `No parsed output for "${req.name}" (stop_reason=${res.stop_reason})`,
      );
    }
    return res.parsed_output as T;
  }
}

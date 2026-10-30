import { z } from "zod";
import { LlmOutputError, LlmUnavailableError, type Llm, type Provider, type StructuredRequest, type Usage } from "./llm.js";

const TIMEOUT_MS = 120_000;
const NUM_CTX = 16384;
const NUM_PREDICT = 8192;

type Fetch = typeof fetch;

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  /** Tests inject a fake; defaults to the global fetch. */
  fetch?: Fetch;
  timeoutMs?: number;
}

/** The JSON schema the model's output must follow (what the request's zod schema accepts). */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

/** The request's text: a local model reads text only (no PDFs or images). */
function textOf(content: StructuredRequest<unknown>["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type !== "text") throw new LlmUnavailableError(`The local model can't read a ${block.type} attachment`);
    parts.push(block.text);
  }
  return parts.join("\n\n");
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/** Why a fetch to Ollama failed, as an LlmUnavailableError (the server is off, too slow, or unreachable). */
function unavailable(err: unknown, baseUrl: string, timeoutMs: number): LlmUnavailableError {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return new LlmUnavailableError(`The local model took longer than ${Math.round(timeoutMs / 1000)}s`);
  if (e?.cause?.code === "ECONNREFUSED") return new LlmUnavailableError(`The local model isn't running (nothing at ${baseUrl}) — start Ollama`);
  return new LlmUnavailableError(`Can't reach the local model at ${baseUrl}: ${e?.cause?.message ?? e?.message ?? String(err)}`);
}

/**
 * A model served by Ollama (POST {baseUrl}/api/chat). The output is constrained to the request's JSON schema and checked
 * with its zod schema; an answer that doesn't parse or validate is asked for once more, then LlmOutputError. A server
 * that is off, missing the model, or too slow throws LlmUnavailableError.
 */
export class OllamaLlm implements Llm, Provider {
  readonly kind = "ollama" as const;
  private readonly baseUrl: string;
  private readonly fetchFn: Fetch;
  private readonly timeoutMs: number;
  readonly model: string;

  constructor(opts: OllamaOptions) {
    this.baseUrl = trimSlash(opts.baseUrl);
    this.model = opts.model;
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    return (await this.run(req)).value;
  }

  async run<T>(req: StructuredRequest<T>): Promise<{ value: T; usage: Usage }> {
    const system = req.cachedContext ? `${req.system}\n\n${req.cachedContext}` : req.system;
    const body = JSON.stringify({
      model: this.model,
      stream: false,
      format: jsonSchemaFor(req.schema),
      options: { temperature: 0, num_ctx: NUM_CTX, num_predict: req.maxTokens ?? NUM_PREDICT },
      messages: [{ role: "system", content: system }, { role: "user", content: textOf(req.content) }],
    });
    const usage: Usage = { model: this.model, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    let problem = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.post(body);
      usage.inputTokens += reply.prompt_eval_count ?? 0;
      usage.outputTokens += reply.eval_count ?? 0;
      const text = reply.message?.content ?? "";
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        problem = `not JSON (${text.slice(0, 80)})`;
        continue;
      }
      const parsed = req.schema.safeParse(json);
      if (parsed.success) return { value: parsed.data, usage };
      problem = parsed.error.issues[0] ? `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}` : "invalid";
    }
    throw new LlmOutputError(`The local model's answer to "${req.name}" was unusable: ${problem}`, usage);
  }

  private async post(body: string): Promise<{ message?: { content?: string }; prompt_eval_count?: number; eval_count?: number }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw unavailable(err, this.baseUrl, this.timeoutMs);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw unavailable(err, this.baseUrl, this.timeoutMs);
    }
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try { detail = (JSON.parse(text) as { error?: string }).error ?? detail; } catch { /* plain text */ }
      if (res.status === 404) throw new LlmUnavailableError(`The local model "${this.model}" isn't installed (ollama pull ${this.model}): ${detail}`);
      throw new LlmUnavailableError(`The local model failed (HTTP ${res.status}): ${detail}`);
    }
    try {
      return JSON.parse(text) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    } catch {
      throw new LlmUnavailableError("The local model's server sent something that isn't JSON");
    }
  }
}

/** The models installed in Ollama (GET {baseUrl}/api/tags), for Settings' "Test connection". */
export async function listOllamaModels(baseUrl: string, fetchFn: Fetch = fetch, timeoutMs = 5_000): Promise<string[]> {
  const url = trimSlash(baseUrl);
  let res: Response;
  try {
    res = await fetchFn(`${url}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw unavailable(err, url, timeoutMs);
  }
  if (!res.ok) throw new LlmUnavailableError(`Ollama answered HTTP ${res.status}`);
  const body = await res.json().catch(() => null) as { models?: { name?: string }[] } | null;
  return (body?.models ?? []).map(m => m.name ?? "").filter(Boolean);
}

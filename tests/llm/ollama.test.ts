import { createServer } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { LlmOutputError, LlmUnavailableError } from "../../src/llm/llm.js";
import { listOllamaModels, OllamaLlm } from "../../src/llm/ollama.js";
import { startFakeOllama } from "../helpers/fake-ollama.js";

const Schema = z.object({ option: z.string().nullable(), confidence: z.enum(["high", "low"]) });
const req = { name: "adapt", schema: Schema, system: "Pick an option.", cachedContext: "<resume>R</resume>", content: '{"q":1}', effort: "low" as const };

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

describe("OllamaLlm", () => {
  test("posts a non-streaming chat with the schema as format, temperature 0 and a 16k context; system and cached context merged", async () => {
    const fake = await startFakeOllama({ reply: () => JSON.stringify({ option: "Yes", confidence: "high" }) });
    close = fake.close;
    const llm = new OllamaLlm({ baseUrl: `${fake.url}/`, model: "qwen2.5:14b" });
    const out = await llm.run(req);
    expect(out.value).toEqual({ option: "Yes", confidence: "high" });
    expect(out.usage).toEqual({ model: "qwen2.5:14b", inputTokens: 100, outputTokens: 20, cacheRead: 0, cacheWrite: 0 });
    expect(fake.requests).toHaveLength(1);
    const body = fake.requests[0]!;
    expect(body.model).toBe("qwen2.5:14b");
    expect(body.stream).toBe(false);
    expect(body.options).toMatchObject({ temperature: 0, num_ctx: 16384 });
    expect(body.messages).toEqual([
      { role: "system", content: "Pick an option.\n\n<resume>R</resume>" },
      { role: "user", content: '{"q":1}' },
    ]);
    expect(body.format).toMatchObject({ type: "object", required: ["option", "confidence"] });
    expect(JSON.stringify(body.format.properties)).toContain('"enum":["high","low"]');
    expect(body.format).not.toHaveProperty("$schema");
  });

  test("an answer that isn't valid JSON or doesn't fit the schema is asked for once more", async () => {
    const fake = await startFakeOllama({ reply: (_b, n) => (n === 1 ? "not json {" : JSON.stringify({ option: null, confidence: "low" })) });
    close = fake.close;
    const out = await new OllamaLlm({ baseUrl: fake.url, model: "m" }).structured(req);
    expect(out).toEqual({ option: null, confidence: "low" });
    expect(fake.requests).toHaveLength(2);
  });

  test("two unusable answers throw LlmOutputError (after exactly one retry)", async () => {
    const fake = await startFakeOllama({ reply: () => JSON.stringify({ option: 3, confidence: "maybe" }) });
    close = fake.close;
    const err = await new OllamaLlm({ baseUrl: fake.url, model: "m" }).run(req).catch(e => e);
    expect(err).toBeInstanceOf(LlmOutputError);
    expect((err as LlmOutputError).usage?.inputTokens).toBe(200);
    expect(fake.requests).toHaveLength(2);
  });

  test("nothing listening on the address throws LlmUnavailableError", async () => {
    // A port that was free a moment ago: connecting is refused.
    const port = await new Promise<number>(resolve => {
      const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    });
    const err = await new OllamaLlm({ baseUrl: `http://127.0.0.1:${port}`, model: "m" }).structured(req).catch(e => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as Error).message).toMatch(/isn't running/);
  });

  test("a model that isn't installed (404) is unavailable, with how to install it", async () => {
    const fake = await startFakeOllama({ reply: () => ({ status: 404, body: JSON.stringify({ error: 'model "nope" not found, try pulling it first' }) }) });
    close = fake.close;
    const err = await new OllamaLlm({ baseUrl: fake.url, model: "nope" }).structured(req).catch(e => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as Error).message).toContain("ollama pull nope");
  });

  test("a model that answers too slowly is unavailable", async () => {
    const fake = await startFakeOllama({ delayMs: 500 });
    close = fake.close;
    const err = await new OllamaLlm({ baseUrl: fake.url, model: "m", timeoutMs: 100 }).structured(req).catch(e => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as Error).message).toMatch(/took longer/);
  });

  test("a PDF attachment can't go to the local model", async () => {
    const llm = new OllamaLlm({ baseUrl: "http://127.0.0.1:9", model: "m", fetch: () => { throw new Error("must not be called"); } });
    const err = await llm.structured({ ...req, content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "AA==" } }] }).catch(e => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
  });

  test("listOllamaModels lists the installed models", async () => {
    const fake = await startFakeOllama({ models: ["qwen2.5:14b", "llama3:8b"] });
    close = fake.close;
    expect(await listOllamaModels(fake.url)).toEqual(["qwen2.5:14b", "llama3:8b"]);
  });
});

import type { Llm, StructuredRequest } from "../../src/llm/llm.js";

type Handler = (req: StructuredRequest<any>) => unknown;

/** The batched match request (answers/match.ts). */
interface BatchMatch {
  newQuestions: { key: string; question: string; isFactual: boolean; candidateIds: number[] }[];
  savedQuestions: { id: number }[];
}

export class FakeLlm implements Llm {
  calls: StructuredRequest<unknown>[] = [];
  private handlers = new Map<string, Handler>();

  on<T>(name: string, handler: (req: StructuredRequest<T>) => T): this {
    this.handlers.set(name, handler as Handler);
    return this;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    this.calls.push(req as StructuredRequest<unknown>);
    const handler = this.handlers.get(req.name);
    if (!handler) throw new Error(`FakeLlm: no handler registered for "${req.name}"`);
    const out = handler(req);
    if (req.name === "match" && out && typeof out === "object" && !("matches" in out)) return this.perQuestion(req, handler) as T;
    return out as T;
  }

  /**
   * A handler written for one question at a time ({ matchId, confidence }) answers a batched match request: it is
   * asked once per new question, with that question's single-question request ({ newQuestion, isFactual, savedQuestions }).
   */
  private perQuestion(req: StructuredRequest<unknown>, handler: Handler): unknown {
    const batch = JSON.parse(String(req.content)) as BatchMatch;
    const saved = new Map(batch.savedQuestions.map(q => [q.id, q]));
    return {
      matches: batch.newQuestions.map(q => {
        const single = { ...req, content: JSON.stringify({ newQuestion: q.question, isFactual: q.isFactual, savedQuestions: q.candidateIds.map(id => saved.get(id)) }) };
        return { key: q.key, ...(handler(single) as { matchId: number | null; confidence: string }) };
      }),
    };
  }
}

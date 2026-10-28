import type { Llm, StructuredRequest } from "../../src/llm/llm.js";

type Handler = (req: StructuredRequest<any>) => unknown;

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
    return handler(req) as T;
  }
}

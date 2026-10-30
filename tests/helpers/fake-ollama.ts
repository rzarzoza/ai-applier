import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface OllamaChatBody {
  model: string;
  stream: boolean;
  format: Record<string, unknown>;
  options: Record<string, unknown>;
  messages: { role: string; content: string }[];
}

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; items?: Schema; enum?: unknown[]; anyOf?: Schema[]; const?: unknown };

/** The smallest value a JSON schema accepts: null where allowed, false, 0, "", [], the first enum value, objects filled in. */
export function minimalFor(schema: Schema): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.anyOf?.length) {
    const nullable = schema.anyOf.find(s => s.type === "null");
    return nullable ? null : minimalFor(schema.anyOf[0]!);
  }
  const type = Array.isArray(schema.type) ? (schema.type.includes("null") ? "null" : schema.type[0]) : schema.type;
  switch (type) {
    case "null": return null;
    case "boolean": return false;
    case "number": case "integer": return 0;
    case "string": return "";
    case "array": return [];
    case "object": return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, minimalFor(v)]));
    default: return null;
  }
}

/**
 * A stand-in for Ollama's HTTP API on 127.0.0.1 (never the real model). /api/chat answers with `reply(body)` (the
 * message content as a string; by default the minimal value the request's `format` schema accepts), /api/tags lists
 * `models`. Every chat request is kept in `requests`.
 */
export async function startFakeOllama(opts: { reply?: (body: OllamaChatBody, n: number) => string | { status: number; body: string }; models?: string[]; delayMs?: number } = {}) {
  const requests: OllamaChatBody[] = [];
  const read = (req: IncomingMessage) => new Promise<string>(resolve => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => resolve(data));
  });
  const server: Server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: (opts.models ?? ["qwen2.5:14b"]).map(name => ({ name })) }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      const body = JSON.parse(await read(req)) as OllamaChatBody;
      requests.push(body);
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      if (res.destroyed) return;
      const out = opts.reply ? opts.reply(body, requests.length) : JSON.stringify(minimalFor(body.format as Schema));
      if (typeof out !== "string") {
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(out.body);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: body.model, message: { role: "assistant", content: out }, done: true, prompt_eval_count: 100, eval_count: 20 }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, requests,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

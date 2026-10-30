import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeLlm } from "../../src/llm/llm.js";

describe.skipIf(!process.env.LIVE)("ClaudeLlm (live)", () => {
  it("returns structured output", async () => {
    const out = await new ClaudeLlm().structured({
      name: "live",
      schema: z.object({ ok: z.boolean() }),
      system: "You return structured data.",
      content: "Return ok=true",
      effort: "low",
    });
    expect(out).toEqual({ ok: true });
  });
});

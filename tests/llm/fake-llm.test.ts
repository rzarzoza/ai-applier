import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeLlm } from "../helpers/fake-llm.js";

const base = { schema: z.object({ ok: z.boolean() }), system: "s", content: "c", effort: "low" as const };

describe("FakeLlm", () => {
  it("returns the registered handler value and records the call", async () => {
    const llm = new FakeLlm().on("classify", () => ({ ok: true }));
    const out = await llm.structured({ ...base, name: "classify" });
    expect(out).toEqual({ ok: true });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.name).toBe("classify");
  });

  it("throws for an unregistered name", async () => {
    const llm = new FakeLlm();
    await expect(llm.structured({ ...base, name: "nope" })).rejects.toThrow(/nope/);
  });
});

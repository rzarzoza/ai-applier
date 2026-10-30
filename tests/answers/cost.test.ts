import { describe, expect, test, vi } from "vitest";
import { adaptAnswer } from "../../src/answers/adapt.js";
import { approveAnswer, createQuestion, listQuestions } from "../../src/answers/bank.js";
import { MAX_LLM_OPTIONS, topOptions } from "../../src/answers/rank.js";
import { resolveFields } from "../../src/answers/resolve.js";
import { openDb, type Db } from "../../src/db/db.js";
import { adapt, getExtToken } from "../../src/ext/api.js";
import type { ResolveResponse } from "../../src/ext/protocol.js";
import type { FieldSpec, JobContext } from "../../src/forms/types.js";
import type { Provider, StructuredRequest } from "../../src/llm/llm.js";
import { RoutedLlm } from "../../src/llm/routed.js";
import { saveProfile } from "../../src/profile/profile.js";
import { saveSettings } from "../../src/settings.js";
import { createApp } from "../../src/web/server.js";
import { FakeLlm } from "../helpers/fake-llm.js";

const job: JobContext = { jobId: "j1", company: "Acme", title: "SWE Intern", location: "Austin, TX", term: "Summer 2027" };

/** A Lever-sized university list (3,301 names) with the applicant's school somewhere in the middle. */
function universities(): string[] {
  const states = ["Texas", "California", "Ohio", "Florida", "Georgia", "Michigan", "Oregon", "Utah", "Iowa", "Maine"];
  const kinds = ["University", "State University", "College", "Institute of Technology", "Community College"];
  const out: string[] = [];
  for (let i = 0; out.length < 3299; i++) {
    const s = states[i % states.length]!;
    const k = kinds[Math.floor(i / states.length) % kinds.length]!;
    out.push(`${["North", "South", "East", "West", "Central"][i % 5]} ${s} ${k} ${Math.floor(i / 50) + 1}`);
  }
  out.splice(1717, 0, "The University of Texas at Austin");
  out.push("Other");
  return out;
}

describe("option lists sent to the LLM", () => {
  test("topOptions keeps at most 30, closest first, in the list's order", () => {
    const list = universities();
    const top = topOptions("University of Texas, Austin", list);
    expect(top.length).toBe(MAX_LLM_OPTIONS);
    expect(top).toContain("The University of Texas at Austin");
    expect(top.map(o => list.indexOf(o))).toEqual([...top.map(o => list.indexOf(o))].sort((a, b) => a - b));
    expect(topOptions("x", ["a", "b"])).toEqual(["a", "b"]);
  });

  test("adaptAnswer sends at most 30 of 3,301 options, the right one among them, and never 'Other'", async () => {
    const llm = new FakeLlm().on("adapt", req => {
      const { options } = JSON.parse(String(req.content)) as { options: string[] };
      return { option: options.find(o => o.includes("Austin")) ?? null };
    });
    const field: FieldSpec = { id: "s", label: "School", kind: "select", required: true, options: universities() };
    expect(await adaptAnswer(llm, "University of Texas, Austin", field, job)).toEqual({ type: "option", option: "The University of Texas at Austin" });
    const sent = JSON.parse(String(llm.calls[0]!.content)) as { options: string[] };
    expect(sent.options.length).toBeLessThanOrEqual(30);
    expect(sent.options).not.toContain("Other");
  });

  test("the extension's /ext/adapt path is trimmed the same way", async () => {
    const db = openDb(":memory:");
    const llm = new FakeLlm().on("adapt", () => ({ option: null })).on("variants", () => ({ variants: [] }));
    const options = universities();
    await adapt({ db, llm }, {
      url: "https://jobs.lever.co/acme/1/apply", field: { id: "s", label: "School", kind: "select", required: true }, value: "Univ of Texas Austin", options,
    });
    expect((JSON.parse(String(llm.calls[0]!.content)) as { options: string[] }).options.length).toBeLessThanOrEqual(30);
  });

  test("classify never sends more than 30 options of a field, and says how many there are", async () => {
    const db = openDb(":memory:");
    const llm = new FakeLlm()
      .on("classify", () => ({ fields: [] }))
      .on("match", () => ({ matchId: null, confidence: "low" }))
      .on("fact", () => ({ answerable: false, answer: null, basis: null }));
    await resolveFields({ db, llm }, [{ id: "s", label: "School", kind: "select", required: false, options: universities() }], job);
    const sent = JSON.parse(String(llm.calls.find(c => c.name === "classify")!.content)) as { fields: { options: string[]; optionCount?: number }[] };
    expect(sent.fields[0]!.options).toHaveLength(30);
    expect(sent.fields[0]!.optionCount).toBe(3301);
    // The fact request also carries at most 30 of them.
    const fact = JSON.parse(String(llm.calls.find(c => c.name === "fact")!.content)) as { field: { options: string[] } };
    expect(fact.field.options.length).toBeLessThanOrEqual(30);
  });
});

describe("classify", () => {
  test("a long form is classified 10 fields per request (each cached as it comes), so a local model stays within its time limit", async () => {
    const db = openDb(":memory:");
    const llm = new FakeLlm().on("classify", req => ({
      fields: (JSON.parse(String(req.content)) as { fields: { id: string }[] }).fields.map(f => ({
        id: f.id, category: "optin-optional", profileKey: null, derivedKey: null, canonicalQuestion: null, isFactual: false, isCompanySpecific: false,
      })),
    }));
    const fields: FieldSpec[] = Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, label: `Opt in to list ${i}`, kind: "checkbox", required: false }));
    const out = await resolveFields({ db, llm }, fields, job);
    expect(out.every(r => r.status === "skip")).toBe(true);
    expect(llm.calls.map(c => (JSON.parse(String(c.content)) as { fields: unknown[] }).fields.length)).toEqual([10, 10, 5]);
    await resolveFields({ db, llm }, fields, job);
    expect(llm.calls).toHaveLength(3);
  });
});

const Q = (id: string, label: string): FieldSpec => ({ id, label, kind: "textarea", required: true });

function bankWith(db: Db, n: number) {
  for (let i = 1; i <= n; i++) {
    const q = createQuestion(db, { canonical: `Saved question number ${i} about topic ${i}?`, kind: "global", isFactual: false });
    approveAnswer(db, q.id, `Answer ${i}`);
  }
}

describe("batched matching", () => {
  const classify = (req: StructuredRequest<unknown>) => ({
    fields: (JSON.parse(String(req.content)) as { fields: { id: string; label: string }[] }).fields.map(f => ({
      id: f.id, category: "question", profileKey: null, derivedKey: null, canonicalQuestion: f.label, isFactual: false, isCompanySpecific: false,
    })),
  });

  test("one match call per form for all its questions, each with at most 20 candidates; a repeat is free", async () => {
    const db = openDb(":memory:");
    bankWith(db, 30);
    const ids = listQuestions(db).map(q => q.id);
    const llm = new FakeLlm()
      .on("classify", classify)
      .on("match", req => {
        const body = JSON.parse(String(req.content)) as { newQuestions: { key: string; question: string; candidateIds: number[] }[] };
        return { matches: body.newQuestions.map(q => ({ key: q.key, matchId: ids[Number(q.question.match(/(\d+)/)![1]) - 1]!, confidence: "high" })) };
      });
    const form = [Q("a", "Topic 3"), Q("b", "Topic 7"), Q("c", "Topic 12")];
    const first = await resolveFields({ db, llm }, form, job);
    expect(first.map(r => r.status)).toEqual(["filled", "filled", "filled"]);
    const matchCalls = llm.calls.filter(c => c.name === "match");
    expect(matchCalls).toHaveLength(1);
    const body = JSON.parse(String(matchCalls[0]!.content)) as { newQuestions: { candidateIds: number[] }[] };
    expect(body.newQuestions).toHaveLength(3);
    for (const q of body.newQuestions) expect(q.candidateIds.length).toBeLessThanOrEqual(20);

    const again = await resolveFields({ db, llm }, form, { ...job, jobId: "j2", company: "Other Co" });
    expect(again).toEqual(first);
    expect(llm.calls.filter(c => c.name === "match")).toHaveLength(1);
  });

  test("a new question in the bank invalidates the cached matches", async () => {
    const db = openDb(":memory:");
    bankWith(db, 3);
    const llm = new FakeLlm().on("classify", classify).on("match", () => ({ matchId: null, confidence: "low" })).on("draft", () => ({ answerable: false, draft: null }));
    await resolveFields({ db, llm }, [Q("a", "Why us?")], job);
    createQuestion(db, { canonical: "Something else entirely?", kind: "global", isFactual: false });
    await resolveFields({ db, llm }, [Q("a", "Why us?")], job);
    expect(llm.calls.filter(c => c.name === "match")).toHaveLength(2);
  });
});

/** A provider that answers every adapt request with the first option it was shown. */
function firstOption(): Provider & { calls: number } {
  const p = {
    kind: "ollama" as const, calls: 0,
    async run<T>(req: StructuredRequest<T>) {
      p.calls++;
      const { options } = JSON.parse(String(req.content)) as { options: string[] };
      return { value: { option: options[0] ?? null } as T, usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  return p;
}

describe("adapt cache", () => {
  test("the same value on the same field (label and options) is mapped once, whatever the company", async () => {
    const db = openDb(":memory:");
    const local = firstOption();
    const llm = new RoutedLlm({ db, ollama: () => local, claude: () => { throw new Error("no Claude"); } });
    const field: FieldSpec = { id: "h", label: "How did you hear about us?", kind: "select", required: true, options: ["LinkedIn job post", "Referral", "Career fair"] };
    const a = await adaptAnswer(llm, "Found it on LinkedIn", field, job);
    const b = await adaptAnswer(llm, "Found it on LinkedIn", { ...field, id: "other-id" }, { ...job, company: "Globex" });
    expect(a).toEqual({ type: "option", option: "LinkedIn job post" });
    expect(b).toEqual(a);
    expect(local.calls).toBe(1);
    // Another value, or other options, is a new request.
    await adaptAnswer(llm, "A friend told me", field, job);
    await adaptAnswer(llm, "Found it on LinkedIn", { ...field, options: ["LinkedIn job post", "Referral"] }, job);
    expect(local.calls).toBe(3);
  });
});

describe("daily budget reached", () => {
  test("Claude is not called; fields are left for the user and the extension says why", async () => {
    const db = openDb(":memory:");
    saveProfile(db, { firstName: "Luis", lastName: "Hernandez", email: "luis@example.com" });
    saveSettings(db, { aiFast: "claude", aiWrite: "claude", aiDailyBudgetUsd: 0.25 });
    db.prepare("INSERT INTO llm_usage (at, task, provider, model, input_tokens, output_tokens, cache_read, cost_usd) VALUES (?, 'draft', 'claude', 'claude-sonnet-5-5', 0, 0, 0, 0.3)")
      .run(new Date().toISOString());
    const claude = vi.fn((): Provider => { throw new Error("Claude must not be built"); });
    const llm = new RoutedLlm({ db, claude, ollama: () => { throw new Error("no local"); } });
    const fields: FieldSpec[] = [Q("w", "Why do you want to work here?"), { id: "o", label: "Anything else?", kind: "text", required: false }];
    const res = await resolveFields({ db, llm }, fields, job);
    expect(res[0]).toMatchObject({ status: "blocked", reason: "missing" });
    expect(res[1]).toMatchObject({ status: "skip" });
    expect(claude).not.toHaveBeenCalled();

    const app = createApp({ db, llm, runInteractive: vi.fn(), runReviewed: vi.fn(), runHandFinish: vi.fn(), pollNow: vi.fn() });
    const r = await app.request("/ext/resolve", {
      method: "POST", headers: { "content-type": "application/json", "x-ai-applier-token": getExtToken(db) },
      body: JSON.stringify({ url: "https://boards.greenhouse.io/acme/jobs/1", title: "SWE Intern", fields: [Q("x", "What is your favorite data structure and why?")] }),
    });
    const body = await r.json() as ResolveResponse;
    expect(body.resolutions[0]).toMatchObject({ status: "needs-you", reason: "missing" });
    expect(body.notice).toMatch(/^AI budget reached for today/);
    expect(claude).not.toHaveBeenCalled();
  });
});

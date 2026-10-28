import { expect, test } from "vitest";
import { openDb, type Db } from "../../src/db/db.js";
import { approveAnswer, createQuestion, getQuestion, listQuestions, setOverride } from "../../src/answers/bank.js";
import type { Classification, FieldCategory } from "../../src/answers/classify.js";
import { resolveFields } from "../../src/answers/resolve.js";
import type { FieldSpec, JobContext } from "../../src/forms/types.js";
import { setStatus, upsertPosting } from "../../src/jobs/repo.js";
import { saveProfile } from "../../src/profile/profile.js";
import { FakeLlm } from "../helpers/fake-llm.js";

const job: JobContext = { jobId: "j1", company: "Acme", title: "SWE Intern", location: "Austin, TX", term: "Summer 2027" };

type C = Partial<Omit<Classification, "category">> & { category: FieldCategory };

/** A "classify" handler that returns the given classification for every listed field id. */
const classifyAs = (map: Record<string, C>) => () => ({
  fields: Object.entries(map).map(([id, c]) => ({
    id, profileKey: null, derivedKey: null, canonicalQuestion: null, isFactual: false, isCompanySpecific: false, ...c,
  })),
});

const f = (id: string, label: string, kind: FieldSpec["kind"], extra: Partial<FieldSpec> = {}): FieldSpec =>
  ({ id, label, kind, required: true, ...extra });

const setup = (): Db => {
  const db = openDb(":memory:");
  saveProfile(db, { firstName: "Luis", lastName: "Zarzoza", email: "luis@example.com", resumePath: "/data/resume.pdf", resumeText: "Built a compiler in Rust." });
  return db;
};

test("profile fields fill from profile; consent checks; opt-in skipped", async () => {
  const db = setup();
  const llm = new FakeLlm().on("classify", classifyAs({
    first: { category: "profile", profileKey: "firstName", isFactual: true },
    email: { category: "profile", profileKey: "email", isFactual: true },
    certify: { category: "consent-required" },
    sign: { category: "consent-required" },
    sms: { category: "optin-optional" },
    resume: { category: "resume" },
    cover: { category: "cover-letter" },
  }));
  const fields = [
    f("first", "First Name *", "text"),
    f("email", "Email", "email"),
    f("certify", "I certify that the information above is accurate", "checkbox"),
    f("sign", "Type your full name as your electronic signature", "text"),
    f("sms", "Text me about new roles", "checkbox", { required: false }),
    f("resume", "Resume/CV", "file"),
    f("cover", "Cover letter", "file", { required: false }),
  ];
  expect(await resolveFields({ db, llm }, fields, job)).toEqual([
    { fieldId: "first", status: "filled", answer: { type: "text", text: "Luis" }, source: "profile" },
    { fieldId: "email", status: "filled", answer: { type: "text", text: "luis@example.com" }, source: "profile" },
    { fieldId: "certify", status: "filled", answer: { type: "check", checked: true }, source: "consent" },
    { fieldId: "sign", status: "filled", answer: { type: "text", text: "Luis Zarzoza" }, source: "consent" },
    { fieldId: "sms", status: "skip" },
    { fieldId: "resume", status: "filled", answer: { type: "file", path: "/data/resume.pdf" }, source: "resume" },
    { fieldId: "cover", status: "skip" },
  ]);
  expect(llm.calls.map(c => c.name)).toEqual(["classify"]);
  expect(llm.calls[0]).toMatchObject({ effort: "low" });
  expect(listQuestions(db)).toHaveLength(0);
});

test("required profile field with null value blocks as missing and creates one question", async () => {
  const db = setup();
  const llm = new FakeLlm().on("classify", classifyAs({ reloc: { category: "profile", profileKey: "willingToRelocate", isFactual: true } }));
  const fields = [f("reloc", "Are you willing to relocate?", "radio", { options: ["Yes", "No"] })];

  const [r1] = await resolveFields({ db, llm }, fields, job);
  expect(r1).toMatchObject({ fieldId: "reloc", status: "blocked", reason: "missing" });
  const qs = listQuestions(db);
  expect(qs).toHaveLength(1);
  expect(qs[0]).toMatchObject({ canonical: "Are you willing to relocate?", kind: "global", isFactual: true, status: "none", options: ["Yes", "No"] });

  const [r2] = await resolveFields({ db, llm }, fields, job);
  expect(r2).toEqual(r1);
  expect(listQuestions(db)).toHaveLength(1);

  // Once the user answers it in the inbox, the next run uses that answer instead of blocking again.
  approveAnswer(db, qs[0]!.id, "Yes");
  const [r3] = await resolveFields({ db, llm }, fields, job);
  expect(r3).toEqual({ fieldId: "reloc", status: "filled", answer: { type: "option", option: "Yes" }, source: "bank" });

  // An optional field with no value is left blank.
  const opt = await resolveFields({ db, llm }, [f("reloc", "Willing to relocate?", "text", { required: false })], { ...job, jobId: "j2" });
  expect(opt).toEqual([{ fieldId: "reloc", status: "skip" }]);
});

test("hispanic yes/no question resolves from profile.hispanicLatino", async () => {
  const db = setup();
  const llm = new FakeLlm().on("classify", classifyAs({ h: { category: "profile", profileKey: "hispanicLatino", isFactual: true } }));
  const res = await resolveFields({ db, llm }, [f("h", "Are you Hispanic or Latino?", "radio", { options: ["Yes", "No"] })], job);
  expect(res).toEqual([{ fieldId: "h", status: "filled", answer: { type: "option", option: "Yes" }, source: "profile" }]);
  expect(llm.calls.map(c => c.name)).toEqual(["classify"]);
});

test("unknown profileKey from the classifier is treated as a question", async () => {
  const db = setup();
  const llm = new FakeLlm()
    .on("classify", classifyAs({ x: { category: "profile", profileKey: "shoeSize" as never, canonicalQuestion: "What is your shoe size?", isFactual: false } }));
  const res = await resolveFields({ db, llm }, [f("x", "Shoe size", "text")], job);
  expect(res[0]).toMatchObject({ status: "blocked", reason: "missing" });
  expect(llm.calls.some(c => c.name === "draft")).toBe(false);
  expect(listQuestions(db)[0]).toMatchObject({ canonical: "What is your shoe size?", isFactual: true, status: "none" });
});

test("derived fields: worked at company, applied before, job location and term", async () => {
  const db = setup();
  saveProfile(db, { employers: ["Acme Corporation", "Initech"] });
  const llm = new FakeLlm().on("classify", classifyAs({
    worked: { category: "derived", derivedKey: "workedAtCompany", isFactual: true },
    applied: { category: "derived", derivedKey: "appliedToCompany", isFactual: true },
    loc: { category: "derived", derivedKey: "jobLocation", isFactual: true },
    term: { category: "derived", derivedKey: "jobTerm", isFactual: true },
  }));
  const res = await resolveFields({ db, llm }, [
    f("worked", "Have you previously worked at Acme?", "radio", { options: ["Yes", "No"] }),
    f("applied", "Have you applied to Acme before?", "select", { options: ["Yes", "No"] }),
    f("loc", "Which office?", "select", { options: ["New York, NY", "Austin, TX"] }),
    f("term", "Which term are you applying for?", "text"),
  ], job);
  expect(res).toEqual([
    { fieldId: "worked", status: "filled", answer: { type: "option", option: "Yes" }, source: "derived" },
    { fieldId: "applied", status: "filled", answer: { type: "option", option: "No" }, source: "derived" },
    { fieldId: "loc", status: "filled", answer: { type: "option", option: "Austin, TX" }, source: "derived" },
    { fieldId: "term", status: "filled", answer: { type: "text", text: "Summer 2027" }, source: "derived" },
  ]);
});

test("unseen open question gets a draft and blocks for approval", async () => {
  const db = setup();
  const llm = new FakeLlm()
    .on("classify", classifyAs({
      proj: { category: "question", canonicalQuestion: "Describe a project you are proud of.", isFactual: false },
      why: { category: "question", canonicalQuestion: "Why do you want to work at {company}?", isFactual: false, isCompanySpecific: true },
    }))
    .on("match", () => ({ matchId: null, confidence: "low" }))
    .on("draft", req => ({ answerable: true, draft: String(req.content).includes("{company}") ? "Acme builds tools I use." : "I built a compiler in Rust." }));
  const res = await resolveFields({ db, llm }, [
    f("proj", "Describe a project you're proud of", "textarea"),
    f("why", "Why Acme?", "textarea", { required: false }),
  ], job);
  const [proj, why] = listQuestions(db);
  expect(proj).toMatchObject({ canonical: "Describe a project you are proud of.", kind: "global", isFactual: false, status: "draft", draft: "I built a compiler in Rust.", variants: ["Describe a project you're proud of"] });
  expect(why).toMatchObject({ kind: "template", status: "draft", draft: "Acme builds tools I use." });
  expect(res).toEqual([
    { fieldId: "proj", status: "blocked", questionId: proj!.id, reason: "approval" },
    { fieldId: "why", status: "blocked", questionId: why!.id, reason: "approval" },
  ]);
  const draft = llm.calls.find(c => c.name === "draft")!;
  expect(draft.effort).toBe("medium");
  expect(draft.cachedContext).toContain("Built a compiler in Rust.");
});

test("open question the resume can't answer blocks missing when required", async () => {
  const db = setup();
  const llm = new FakeLlm()
    .on("classify", classifyAs({ q: { category: "question", canonicalQuestion: "Describe your experience with FPGAs.", isFactual: false } }))
    .on("draft", () => ({ answerable: false, draft: null }));
  const res = await resolveFields({ db, llm }, [f("q", "FPGA experience", "textarea")], job);
  expect(res[0]).toMatchObject({ status: "blocked", reason: "missing" });
  expect(getQuestion(db, (res[0] as { questionId: number }).questionId)).toMatchObject({ status: "none", draft: null });
});

test("approved bank answer is reused for a differently worded question", async () => {
  const db = setup();
  const q = createQuestion(db, { canonical: "Are you legally authorized to work in the US?", kind: "global", isFactual: true });
  approveAnswer(db, q.id, "Yes");
  const llm = new FakeLlm()
    .on("classify", classifyAs({ auth: { category: "question", canonicalQuestion: "Do you have US work authorization?", isFactual: true } }))
    .on("match", () => ({ matchId: q.id, confidence: "high" }));
  const res = await resolveFields({ db, llm }, [f("auth", "Do you have US work authorization?", "radio", { options: ["Yes", "No"] })], job);
  expect(res).toEqual([{ fieldId: "auth", status: "filled", answer: { type: "option", option: "Yes" }, source: "bank" }]);
  expect(getQuestion(db, q.id)).toMatchObject({ variants: ["Do you have US work authorization?"], useCount: 1 });
  expect(llm.calls.find(c => c.name === "match")!.effort).toBe("low");
});

test("factual question with no match blocks missing, never drafts", async () => {
  const db = setup();
  const other = createQuestion(db, { canonical: "Will you require visa sponsorship now or in the future?", kind: "global", isFactual: true });
  approveAnswer(db, other.id, "No");
  const llm = new FakeLlm()
    .on("classify", classifyAs({ cl: { category: "question", canonicalQuestion: "Do you hold a security clearance?", isFactual: true } }))
    // A medium-confidence match is not enough for a factual question.
    .on("match", () => ({ matchId: other.id, confidence: "medium" }))
    .on("draft", () => ({ answerable: true, draft: "Yes" }));
  const res = await resolveFields({ db, llm }, [f("cl", "Do you hold an active security clearance?", "radio", { options: ["Yes", "No"] })], job);
  expect(llm.calls.some(c => c.name === "draft")).toBe(false);
  const created = listQuestions(db).find(x => x.id !== other.id)!;
  expect(created).toMatchObject({ canonical: "Do you hold a security clearance?", isFactual: true, status: "none", options: ["Yes", "No"] });
  expect(res).toEqual([{ fieldId: "cl", status: "blocked", questionId: created.id, reason: "missing" }]);
  expect(getQuestion(db, other.id)!.useCount).toBe(0);
});

test("matched question still in draft or unanswered blocks; optional unanswered skips", async () => {
  const db = setup();
  const drafted = createQuestion(db, { canonical: "What are your career goals?", kind: "global", isFactual: false, draft: "To build things." });
  const unanswered = createQuestion(db, { canonical: "What is your expected salary?", kind: "global", isFactual: true });
  const llm = new FakeLlm()
    .on("classify", classifyAs({
      goals: { category: "question", canonicalQuestion: "Career goals?", isFactual: false },
      pay: { category: "question", canonicalQuestion: "Salary expectations?", isFactual: true },
      pay2: { category: "question", canonicalQuestion: "Salary expectations?", isFactual: true },
    }))
    .on("match", req => ({ matchId: JSON.parse(String(req.content)).newQuestion === "Career goals?" ? drafted.id : unanswered.id, confidence: "high" }));
  const res = await resolveFields({ db, llm }, [
    f("goals", "Career goals", "textarea"),
    f("pay", "Salary expectations", "text"),
    f("pay2", "Desired pay", "text", { required: false }),
  ], job);
  expect(res).toEqual([
    { fieldId: "goals", status: "blocked", questionId: drafted.id, reason: "approval" },
    { fieldId: "pay", status: "blocked", questionId: unanswered.id, reason: "missing" },
    { fieldId: "pay2", status: "skip" },
  ]);
  expect(listQuestions(db)).toHaveLength(2);
});

test("template answer is filled for the current company", async () => {
  const db = setup();
  const t = createQuestion(db, { canonical: "Why do you want to work at {company}?", kind: "template", isFactual: false });
  approveAnswer(db, t.id, "I admire Initech's focus on developer tools.", "template");
  const llm = new FakeLlm()
    .on("classify", classifyAs({ why: { category: "question", canonicalQuestion: "Why do you want to work at {company}?", isFactual: false, isCompanySpecific: true } }))
    .on("match", () => ({ matchId: t.id, confidence: "high" }))
    .on("template", () => ({ text: "I admire Acme's focus on developer tools." }));
  const res = await resolveFields({ db, llm }, [f("why", "Why do you want to work at Acme?", "textarea", { maxLength: 1000 })], job);
  expect(res).toEqual([{ fieldId: "why", status: "filled", answer: { type: "text", text: "I admire Acme's focus on developer tools." }, source: "template" }]);
  const call = llm.calls.find(c => c.name === "template")!;
  expect(JSON.stringify(call.content)).toContain("Acme");
  expect(JSON.stringify(call.content)).toContain("I admire Initech's focus on developer tools.");
});

test("per-job override wins over everything and skips classification", async () => {
  const db = setup();
  const { job: row } = upsertPosting(db, { sourceId: "s", listingId: "1", company: "Acme", title: "SWE Intern", locations: ["Austin, TX"],
    category: null, terms: [], degrees: [], sponsorship: null, url: "https://x.test/1", datePosted: new Date("2026-10-20"), active: true });
  setStatus(db, row.id, "queued");
  setOverride(db, row.id, "Phone", { type: "text", text: "5125550100" });
  const llm = new FakeLlm();
  const res = await resolveFields({ db, llm }, [f("phone", "Phone *", "tel")], { ...job, jobId: row.id });
  expect(res).toEqual([{ fieldId: "phone", status: "filled", answer: { type: "text", text: "5125550100" }, source: "override" }]);
  expect(llm.calls).toHaveLength(0);
});

test("field_cache avoids a second classify call for the same form", async () => {
  const db = setup();
  saveProfile(db, { employers: ["Beta"] });
  const llm = new FakeLlm().on("classify", classifyAs({
    email: { category: "profile", profileKey: "email", isFactual: true },
    worked: { category: "derived", derivedKey: "workedAtCompany", isFactual: true },
  }));
  const form = (company: string): FieldSpec[] => [
    f("email", "Email Address *", "email"),
    f("worked", `Have you ever worked at ${company}?`, "radio", { options: ["No", "Yes"] }),
  ];
  const a = await resolveFields({ db, llm }, form("Acme"), job);
  // Same form at another company, with different whitespace, case and option order.
  const b = await resolveFields({ db, llm }, [
    f("email", "email   address", "email"),
    f("worked", "Have you ever worked at BETA?", "radio", { options: ["Yes", "No"] }),
  ], { ...job, jobId: "j2", company: "Beta" });
  expect(llm.calls.filter(c => c.name === "classify")).toHaveLength(1);
  expect(a[1]).toMatchObject({ answer: { type: "option", option: "No" } });
  expect(b[1]).toMatchObject({ answer: { type: "option", option: "Yes" } });
  expect(b[0]).toMatchObject({ answer: { type: "text", text: "luis@example.com" } });

  // A form with one new field asks only about that field.
  llm.on("classify", classifyAs({ phone: { category: "profile", profileKey: "phone", isFactual: true } }));
  await resolveFields({ db, llm }, [...form("Acme"), f("phone", "Phone", "tel", { required: false })], job);
  const classifyCalls = llm.calls.filter(c => c.name === "classify");
  expect(classifyCalls).toHaveLength(2);
  expect(JSON.parse(String(classifyCalls[1]!.content)).fields.map((x: { id: string }) => x.id)).toEqual(["phone"]);
});

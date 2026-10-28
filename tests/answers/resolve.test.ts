import { expect, test } from "vitest";
import { openDb, type Db } from "../../src/db/db.js";
import { addVariant, approveAnswer, createQuestion, getQuestion, listQuestions, setOverride } from "../../src/answers/bank.js";
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
    .on("classify", classifyAs({ x: { category: "profile", profileKey: "shoeSize" as never, canonicalQuestion: "What is your shoe size?", isFactual: false } }))
    .on("fact", () => ({ answerable: false, answer: null, basis: null }));
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
    .on("draft", () => ({ answerable: true, draft: "Yes" }))
    .on("fact", () => ({ answerable: false, answer: null, basis: null }));
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
    .on("match", req => ({ matchId: JSON.parse(String(req.content)).newQuestion === "Career goals?" ? drafted.id : unanswered.id, confidence: "high" }))
    .on("fact", () => ({ answerable: false, answer: null, basis: null }));
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

test("a factual attestation checkbox is answered from the profile, not ticked as consent", async () => {
  const db = setup();
  const llm = new FakeLlm().on("classify", classifyAs({ auth: { category: "profile", profileKey: "workAuthorizedUS", isFactual: true } }));
  const fields = [f("auth", "I certify that I am legally authorized to work in the US", "checkbox")];
  expect(await resolveFields({ db, llm }, fields, job))
    .toEqual([{ fieldId: "auth", status: "filled", answer: { type: "check", checked: true }, source: "profile" }]);
  saveProfile(db, { workAuthorizedUS: false });
  expect(await resolveFields({ db, llm }, fields, job))
    .toEqual([{ fieldId: "auth", status: "filled", answer: { type: "check", checked: false }, source: "profile" }]);
});

test("workedAtCompany needs the same company name, not an overlapping one", async () => {
  const llm = new FakeLlm().on("classify", classifyAs({ worked: { category: "derived", derivedKey: "workedAtCompany", isFactual: true } }));
  const fields = [f("worked", "Have you worked here before?", "radio", { options: ["Yes", "No"] })];
  const run = async (employers: string[], company: string) => {
    const db = setup();
    saveProfile(db, { employers });
    return (await resolveFields({ db, llm }, fields, { ...job, company }))[0];
  };
  expect(await run(["Acme Corp."], "Acme, Inc.")).toMatchObject({ status: "filled", answer: { option: "Yes" } });
  expect(await run(["Initech"], "Acme")).toMatchObject({ status: "filled", answer: { option: "No" } });
  expect(await run(["H&R Block"], "Block")).toMatchObject({ status: "blocked", reason: "missing" });
  expect(await run(["Meta"], "Meta Financial Group")).toMatchObject({ status: "blocked", reason: "missing" });
});

test("consent only ticks or agrees on choice fields; other kinds are not guessed", async () => {
  const db = setup();
  const llm = new FakeLlm().on("classify", classifyAs({
    date: { category: "consent-required" },
    mail: { category: "consent-required" },
    agree: { category: "consent-required" },
  }));
  const res = await resolveFields({ db, llm }, [
    f("date", "Date of signature", "date"),
    f("mail", "Consent email", "email", { required: false }),
    f("agree", "Do you agree to the privacy policy?", "radio", { options: ["Yes", "No"] }),
  ], job);
  expect(res[0]).toMatchObject({ fieldId: "date", status: "blocked", reason: "missing" });
  expect(res[1]).toEqual({ fieldId: "mail", status: "skip" });
  expect(res[2]).toEqual({ fieldId: "agree", status: "filled", answer: { type: "option", option: "Yes" }, source: "consent" });
});

test("an unfillable fact never reuses a template answer with the same label", async () => {
  const db = setup();
  const t = createQuestion(db, { canonical: "Are you willing to relocate?", kind: "template", isFactual: false });
  approveAnswer(db, t.id, "Yes, happy to move to Initech's offices.", "template");
  const llm = new FakeLlm().on("classify", classifyAs({ reloc: { category: "profile", profileKey: "willingToRelocate", isFactual: true } }));
  const [r] = await resolveFields({ db, llm }, [f("reloc", "Are you willing to relocate?", "text")], job);
  expect(r).toMatchObject({ status: "blocked", reason: "missing" });
  expect((r as { questionId: number }).questionId).not.toBe(t.id);
  expect(getQuestion(db, t.id)!.useCount).toBe(0);
});

test("same-label fields with different descriptions are classified separately, in one form and in the cache", async () => {
  const db = setup();
  const llm = new FakeLlm().on("classify", classifyAs({
    terms: { category: "consent-required" },
    sms: { category: "optin-optional" },
  }));
  const fields = [
    f("terms", "I agree", "checkbox", { description: "I agree to the privacy policy and terms." }),
    f("sms", "I agree", "checkbox", { required: false, description: "Send me text messages about new roles." }),
  ];
  const res = await resolveFields({ db, llm }, fields, job);
  expect(JSON.parse(String(llm.calls[0]!.content)).fields.map((x: { id: string }) => x.id)).toEqual(["terms", "sms"]);
  expect(res).toEqual([
    { fieldId: "terms", status: "filled", answer: { type: "check", checked: true }, source: "consent" },
    { fieldId: "sms", status: "skip" },
  ]);
  // A later form reuses both cached classifications by description.
  await resolveFields({ db, llm }, [{ ...fields[1]!, id: "x" }, { ...fields[0]!, id: "y" }], { ...job, jobId: "j2" });
  expect(llm.calls.filter(c => c.name === "classify")).toHaveLength(1);
});

test("file uploads: the resume when there is one; otherwise required files need one, optional ones are skipped", async () => {
  const db = setup();
  const llm = new FakeLlm().on("classify", classifyAs({
    cv: { category: "resume" },
    transcript: { category: "question", canonicalQuestion: "Upload your transcript", isFactual: true },
    cover: { category: "cover-letter" },
    extra: { category: "question", canonicalQuestion: "Portfolio", isFactual: true },
  }));
  const fields = [f("cv", "Resume/CV", "file"), f("transcript", "Transcript", "file"), f("cover", "Cover Letter", "file"),
    f("extra", "Portfolio", "file", { required: false })];
  expect(await resolveFields({ db, llm }, fields, job)).toEqual([
    { fieldId: "cv", status: "filled", answer: { type: "file", path: "/data/resume.pdf" }, source: "resume" },
    { fieldId: "transcript", status: "needs-file", resume: false },
    { fieldId: "cover", status: "needs-file", resume: false },
    { fieldId: "extra", status: "skip" },
  ]);
  saveProfile(db, { resumePath: null });
  expect((await resolveFields({ db, llm }, fields.slice(0, 1), job))[0]).toEqual({ fieldId: "cv", status: "needs-file", resume: true });
  expect(listQuestions(db)).toEqual([]);
});

test("a saved question with exactly the same canonical text matches without asking the LLM", async () => {
  const db = setup();
  const q = createQuestion(db, { canonical: "Do you hold a security clearance?", kind: "global", isFactual: true });
  approveAnswer(db, q.id, "No");
  const v = createQuestion(db, { canonical: "Expected graduation date", kind: "global", isFactual: true });
  addVariant(db, v.id, "When do you expect to graduate?");
  approveAnswer(db, v.id, "May 2028");
  const llm = new FakeLlm()
    .on("classify", classifyAs({
      cl: { category: "question", canonicalQuestion: "do you hold a security clearance", isFactual: true },
      grad: { category: "question", canonicalQuestion: "When do you expect to graduate?", isFactual: true },
    }))
    .on("match", () => ({ matchId: null, confidence: "low" }))
    .on("fact", () => ({ answerable: false, answer: null, basis: null }));
  const res = await resolveFields({ db, llm }, [
    f("cl", "Do you currently hold a clearance?", "radio", { options: ["Yes", "No"] }),
    // Matching a variant's wording is not enough: only canonical text short-circuits.
    f("grad", "When do you expect to graduate?", "text"),
  ], job);
  expect(llm.calls.map(c => c.name)).toEqual(["classify", "match", "fact"]);
  expect(res[0]).toEqual({ fieldId: "cl", status: "filled", answer: { type: "option", option: "No" }, source: "bank" });
  expect(res[1]).toMatchObject({ status: "blocked" });
});

test("short generic labels never short-circuit the matcher, even with the same canonical text", async () => {
  const db = setup();
  const q = createQuestion(db, { canonical: "Please explain", kind: "global", isFactual: true });
  approveAnswer(db, q.id, "I was relocating for family reasons.");
  const llm = new FakeLlm()
    .on("classify", classifyAs({ why: { category: "question", canonicalQuestion: "Please explain", isFactual: true } }))
    .on("match", () => ({ matchId: null, confidence: "low" }))
    .on("fact", () => ({ answerable: false, answer: null, basis: null }));
  const res = await resolveFields({ db, llm }, [f("why", "Please explain", "textarea")], job);
  expect(llm.calls.map(c => c.name)).toEqual(["classify", "match", "fact"]);
  expect(res[0]).toMatchObject({ status: "blocked" });
  expect(getQuestion(db, q.id)!.useCount).toBe(0);
});

/** A "fact" handler that answers each question (by the field's label) from a fixed table; anything else is not answerable. */
const factBy = (table: Record<string, { answer: string; basis: string }>) => (req: { content: unknown }) => {
  const hit = table[JSON.parse(String(req.content)).field.label as string];
  return hit ? { answerable: true, ...hit } : { answerable: false, answer: null, basis: null };
};

const EXPORT_CONTROL = "Are you one of the following: a U.S. citizen, a U.S. national, a lawful permanent resident, an asylee or refugee?";
const SCHOOL = "Please list the school or university you will be enrolled in during the internship or co-op?";

test("a factual question the profile answers becomes a draft with its basis and waits for approval, never sent unapproved", async () => {
  const db = setup();
  saveProfile(db, { school: "Rice University", usCitizen: true, relatedToEmployee: null });
  const llm = new FakeLlm()
    .on("classify", classifyAs({
      exp: { category: "question", canonicalQuestion: "Are you a U.S. citizen, national, LPR, asylee or refugee?", isFactual: true },
      school: { category: "question", canonicalQuestion: "School enrolled in during the internship", isFactual: true },
      rel: { category: "question", canonicalQuestion: "Are you related to a {company} employee?", isFactual: true },
      opt: { category: "question", canonicalQuestion: "Preferred school", isFactual: true },
    }))
    .on("match", () => ({ matchId: null, confidence: "low" }))
    .on("draft", () => { throw new Error("factual questions are never drafted"); })
    .on("fact", factBy({
      [EXPORT_CONTROL]: { answer: "Yes", basis: "profile.usCitizen = true" },
      [SCHOOL]: { answer: "Rice University", basis: "profile.school = Rice University" },
    }));
  const res = await resolveFields({ db, llm }, [
    f("exp", EXPORT_CONTROL, "radio", { options: ["Yes", "No"] }),
    f("school", SCHOOL, "textarea", { required: false }),
    f("rel", "Are you related to a Acme employee?", "radio", { options: ["Yes", "No"] }),
  ], job);
  const [exp, school, rel] = listQuestions(db);
  expect(exp).toMatchObject({ status: "draft", draft: "Yes", draftBasis: "profile.usCitizen = true", answer: null, isFactual: true });
  expect(school).toMatchObject({ status: "draft", draft: "Rice University", draftBasis: "profile.school = Rice University" });
  expect(rel).toMatchObject({ status: "none", draft: null, draftBasis: null });
  expect(res).toEqual([
    { fieldId: "exp", status: "blocked", questionId: exp!.id, reason: "approval" },
    // Optional or not, a suggestion is approved once before it is ever sent.
    { fieldId: "school", status: "blocked", questionId: school!.id, reason: "approval" },
    { fieldId: "rel", status: "blocked", questionId: rel!.id, reason: "missing" },
  ]);
  const fact = llm.calls.find(c => c.name === "fact")!;
  expect(fact.effort).toBe("low");
  expect(fact.cachedContext).toContain("Built a compiler in Rust.");
  expect(fact.cachedContext).toContain("Rice University");
  expect(llm.calls.some(c => c.name === "draft")).toBe(false);
});

test("a fact answer that isn't exactly one of the field's options is rejected", async () => {
  const db = setup();
  const llm = new FakeLlm()
    .on("classify", classifyAs({ exp: { category: "question", canonicalQuestion: "Export control status", isFactual: true } }))
    .on("match", () => ({ matchId: null, confidence: "low" }))
    .on("fact", () => ({ answerable: true, answer: "Yes, I am a U.S. citizen", basis: "profile.usCitizen = true" }));
  const [r] = await resolveFields({ db, llm }, [f("exp", EXPORT_CONTROL, "radio", { options: ["Yes", "No"] })], job);
  expect(r).toMatchObject({ status: "blocked", reason: "missing" });
  expect(listQuestions(db)[0]).toMatchObject({ status: "none", draft: null });
});

test("a matched factual question still unanswered gets a fact draft; an approved draft fills later forms", async () => {
  const db = setup();
  const q = createQuestion(db, { canonical: "When could you start a summer internship?", kind: "global", isFactual: true });
  saveProfile(db, { earliestStart: "May 1st 2027" });
  const llm = new FakeLlm()
    .on("classify", classifyAs({ start: { category: "question", canonicalQuestion: "Internship start availability", isFactual: true } }))
    .on("match", () => ({ matchId: q.id, confidence: "high" }))
    .on("fact", () => ({ answerable: true, answer: "May 1st 2027", basis: "profile.earliestStart = May 1st 2027" }));
  const fields = [f("start", "When would you be available to start a summer internship?", "text")];
  expect(await resolveFields({ db, llm }, fields, job)).toEqual([{ fieldId: "start", status: "blocked", questionId: q.id, reason: "approval" }]);
  expect(getQuestion(db, q.id)).toMatchObject({ status: "draft", draft: "May 1st 2027", draftBasis: "profile.earliestStart = May 1st 2027", answer: null });

  approveAnswer(db, q.id, "May 1st 2027");
  expect(await resolveFields({ db, llm }, fields, { ...job, jobId: "j2" }))
    .toEqual([{ fieldId: "start", status: "filled", answer: { type: "text", text: "May 1st 2027" }, source: "bank" }]);
});

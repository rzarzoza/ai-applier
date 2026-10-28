import { expect, test } from "vitest";
import { adaptAnswer, pickOption } from "../../src/answers/adapt.js";
import type { FieldSpec, JobContext } from "../../src/forms/types.js";
import { FakeLlm } from "../helpers/fake-llm.js";

const job: JobContext = { jobId: "j1", company: "Acme", title: "SWE Intern", location: "Austin, TX", term: "Summer 2027" };
const select = (options: string[]): FieldSpec => ({ id: "s", label: "Work authorization", kind: "select", required: true, options });
const textarea: FieldSpec = { id: "t", label: "Tell us about yourself", kind: "textarea", required: true };

test("pickOption maps booleans and near-matches; null when ambiguous", () => {
  expect(pickOption(true, ["Yes", "No"])).toBe("Yes");
  expect(pickOption("Hispanic or Latino", ["Hispanic or Latino", "Not Hispanic or Latino", "Decline"])).toBe("Hispanic or Latino");
  expect(pickOption("Male", ["Female", "Male", "Non-binary"])).toBe("Male");
  expect(pickOption("Texas", ["Yes", "No"])).toBeNull();
});

test("pickOption uses containment but never across a negation", () => {
  expect(pickOption("United States", ["Canada", "United States of America"])).toBe("United States of America");
  expect(pickOption("Hispanic or Latino", ["Not Hispanic or Latino", "Decline to answer"])).toBeNull();
  expect(pickOption("Not Hispanic or Latino", ["Hispanic or Latino", "Decline to answer"])).toBeNull();
  expect(pickOption(true, ["I am authorized", "I am not authorized"])).toBeNull();
  // A candidate rejected for negation still makes the match ambiguous.
  expect(pickOption("Hispanic", ["Hispanic or Latino", "Not Hispanic or Latino"])).toBeNull();
});

test("pickOption maps yes/no only onto plain yes/no options", () => {
  expect(pickOption("Yes", ["Yes, I am authorized and do not need sponsorship", "Yes, but I need sponsorship", "No"])).toBeNull();
  expect(pickOption("Yes", ["Yes, but I will need sponsorship", "No"])).toBeNull();
  expect(pickOption("No", ["Yes", "No, but I will in the future"])).toBeNull();
  expect(pickOption(false, ["Yes, I will require sponsorship", "No, I will not require sponsorship"])).toBeNull();
  expect(pickOption(false, ["Yes", "N/A"])).toBeNull();
  expect(pickOption(false, ["Yes", "No preference"])).toBeNull();
  expect(pickOption("no", ["YES", "NO"])).toBe("NO");
  expect(pickOption(true, ["True", "False"])).toBe("True");
});

test("adaptAnswer never returns an option not in the list", async () => {
  const llm = new FakeLlm().on("adapt", () => ({ option: "Something else" }));
  expect(await adaptAnswer(llm, "U.S. citizen", select(["Citizen or permanent resident", "Visa holder"]), job)).toBeNull();
});

test("adaptAnswer accepts an LLM-chosen option that is in the list", async () => {
  const llm = new FakeLlm().on("adapt", () => ({ option: "Citizen or permanent resident" }));
  expect(await adaptAnswer(llm, "U.S. citizen", select(["Citizen or permanent resident", "Visa holder"]), job))
    .toEqual({ type: "option", option: "Citizen or permanent resident" });
  expect(llm.calls[0]).toMatchObject({ name: "adapt", effort: "low" });
});

test("adaptAnswer shortens text over maxLength via LLM and enforces the limit", async () => {
  const llm = new FakeLlm().on("adapt", () => ({ text: "x".repeat(480) }));
  const a = await adaptAnswer(llm, "y".repeat(900), { ...textarea, maxLength: 500 }, job);
  expect(a).toEqual({ type: "text", text: "x".repeat(480) });

  const tooLong = new FakeLlm().on("adapt", () => ({ text: "x".repeat(501) }));
  expect(await adaptAnswer(tooLong, "y".repeat(900), { ...textarea, maxLength: 500 }, job)).toBeNull();
});

test("adaptAnswer is deterministic when it can be", async () => {
  const llm = new FakeLlm();
  expect(await adaptAnswer(llm, "short", { ...textarea, maxLength: 500 }, job)).toEqual({ type: "text", text: "short" });
  expect(await adaptAnswer(llm, true, { ...textarea, kind: "text" }, job)).toEqual({ type: "text", text: "Yes" });
  expect(await adaptAnswer(llm, false, { ...textarea, kind: "checkbox" }, job)).toEqual({ type: "check", checked: false });
  expect(await adaptAnswer(llm, "Yes", { ...textarea, kind: "checkbox" }, job)).toEqual({ type: "check", checked: true });
  expect(await adaptAnswer(llm, "Male", select(["Female", "Male"]), job)).toEqual({ type: "option", option: "Male" });
  expect(await adaptAnswer(llm, "Hispanic or Latino", { ...select(["Hispanic or Latino", "White", "Asian"]), kind: "checkbox-group" }, job))
    .toEqual({ type: "options", options: ["Hispanic or Latino"] });
  expect(llm.calls).toHaveLength(0);
});

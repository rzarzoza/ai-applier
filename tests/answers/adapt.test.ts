import { expect, test } from "vitest";
import { adaptAnswer, isLocationAnswer, locationQueries, pickLocation, pickOption } from "../../src/answers/adapt.js";
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

test("pickLocation takes only an option naming the city and its state", () => {
  expect(pickLocation("Houston, Texas", ["Houston County, Alabama", "Houston, Texas, United States"])).toBe("Houston, Texas, United States");
  expect(pickLocation("Houston, Texas", ["Houston, TX, USA"])).toBe("Houston, TX, USA");
  expect(pickLocation("Houston, TX", ["Houston, Texas, United States"])).toBe("Houston, Texas, United States");
  // The city itself over a neighborhood or a same-named county; the country-naming one among equals.
  expect(pickLocation("Houston, Texas", ["Houston Heights, Houston, Texas, United States", "Houston, Texas"])).toBe("Houston, Texas");
  expect(pickLocation("Houston, Texas", ["Houston, Texas", "Houston, Texas, United States"])).toBe("Houston, Texas");
  expect(pickLocation("Houston, Texas", ["Houston, TX", "Houston, TX, United States"])).toBe("Houston, TX, United States");
  // Never a list without the city, the city in another state, or the state's name standing in for the city.
  expect(pickLocation("Houston, Texas", ["Other Cast, Bihar, India", "Houston County, Alabama", "Houston, MS, USA"])).toBeNull();
  expect(pickLocation("Houston, Texas", ["Austin, Texas, United States", "Texas City, Texas"])).toBeNull();
  expect(pickLocation("New York, New York", ["Albany, New York, United States"])).toBeNull();
  expect(pickLocation("New York, New York", ["Albany, New York", "New York, NY, USA"])).toBe("New York, NY, USA");
  // Without a state, only an unambiguous city.
  expect(pickLocation("Houston", ["Houston, TX", "Houston, MS"])).toBeNull();
  expect(pickLocation("Houston", ["Houston, TX", "Austin, TX"])).toBe("Houston, TX");
  expect(pickLocation("Houston", ["Houston County, Alabama"])).toBeNull();
  expect(locationQueries("Houston, Texas")).toEqual(["Houston, Texas", "Houston", "Houston, TX"]);
});

test("isLocationAnswer: a place answer to a location question, not a yes/no or relocation", () => {
  const f = (label: string): FieldSpec => ({ id: "l", label, kind: "combobox", required: true });
  expect(isLocationAnswer(f("Location (City)"), "Houston, Texas")).toBe(true);
  expect(isLocationAnswer(f("Where are you currently located?"), "Houston, Texas")).toBe(true);
  expect(isLocationAnswer(f("Are you able to work from this location?"), "Yes")).toBe(false);
  expect(isLocationAnswer(f("Are you able to work from this location?"), true)).toBe(false);
  expect(isLocationAnswer(f("Are you open to relocation?"), "Houston, Texas")).toBe(false);
  expect(isLocationAnswer(f("School"), "Houston, Texas")).toBe(false);
});

test("adaptAnswer maps a place only onto that place; an LLM pick lacking the city is rejected", async () => {
  const loc = (options: string[]): FieldSpec => ({ id: "l", label: "Location (City)", kind: "combobox", required: true, options });
  const noLlm = new FakeLlm();
  expect(await adaptAnswer(noLlm, "Houston, Texas", loc(["Houston County, Alabama", "Houston, Texas, United States"]), job))
    .toEqual({ type: "option", option: "Houston, Texas, United States" });
  // Containment would have taken the only Houston; a place in another state is not the applicant's.
  const llm1 = new FakeLlm().on("adapt", () => ({ option: "Other Cast, Bihar, India" }));
  expect(await adaptAnswer(llm1, "Houston, Texas", loc(["Other Cast, Bihar, India", "Houston County, Alabama"]), job)).toBeNull();
  const llm2 = new FakeLlm().on("adapt", () => ({ option: "Houston County, Alabama" }));
  expect(await adaptAnswer(llm2, "Houston, Texas", loc(["Other Cast, Bihar, India", "Houston County, Alabama"]), job)).toBeNull();
  expect(llm2.calls).toHaveLength(1);
  // An LLM pick naming the city and state is kept.
  const llm3 = new FakeLlm().on("adapt", () => ({ option: "Greater Houston Area, TX" }));
  expect(await adaptAnswer(llm3, "Houston, Texas", loc(["Greater Houston Area, TX", "Austin, TX"]), job))
    .toEqual({ type: "option", option: "Greater Houston Area, TX" });
  // A non-place answer to a location question still maps when an option states it.
  expect(await adaptAnswer(noLlm, "No preference", loc(["New York, NY", "No preference"]), job)).toEqual({ type: "option", option: "No preference" });
});

test("adaptAnswer never maps a real value onto an Other-like option, whoever proposes it", async () => {
  const school = (options: string[], kind: FieldSpec["kind"] = "select"): FieldSpec =>
    ({ id: "s", label: "Which institution do you attend? If not listed select Other", kind, required: true, options });
  const llm = new FakeLlm().on("adapt", () => ({ option: "Other" }));
  expect(await adaptAnswer(llm, "Rice University", school(["Harvard University", "Stanford University", "Other"]), job)).toBeNull();
  expect(llm.calls).toHaveLength(1);
  const llm2 = new FakeLlm().on("adapt", () => ({ option: "Other (School Not Listed)" }));
  expect(await adaptAnswer(llm2, "Rice University", school(["Harvard University", "Other (School Not Listed)"], "radio"), job)).toBeNull();
  // Deterministic containment would have taken "Other" for a value mentioning "other".
  const none = new FakeLlm().on("adapt", () => ({ option: null }));
  expect(await adaptAnswer(none, "The Other School of Design", school(["Harvard University", "Other"]), job)).toBeNull();
  // Multi-select: an Other among the LLM's picks rejects the mapping.
  const multi = new FakeLlm().on("adapt", () => ({ options: ["Java", "Other"] }));
  const langs: FieldSpec = { id: "c", label: "Languages", kind: "checkbox-group", required: true, options: ["Python", "Java", "Other"] };
  expect(await adaptAnswer(multi, "Rust, Go", langs, job)).toBeNull();
  // A value that itself says "Other" still maps onto the Other option.
  expect(await adaptAnswer(new FakeLlm(), "Other", school(["Harvard University", "Other"]), job)).toEqual({ type: "option", option: "Other" });
  // A real match is unaffected.
  const rice = new FakeLlm().on("adapt", () => ({ option: "William Marsh Rice University" }));
  expect(await adaptAnswer(rice, "Rice University", school(["William Marsh Rice University", "Other"]), job))
    .toEqual({ type: "option", option: "William Marsh Rice University" });
});

test("a country maps onto its option under any of its names, without the LLM", async () => {
  const llm = new FakeLlm();
  const sel = (label: string, options: string[]): FieldSpec => ({ id: "c", label, kind: "select", required: true, options });
  const job = { jobId: "j", company: "Acme", title: "Intern", location: "", term: null };
  expect(await adaptAnswer(llm, "USA", sel("Country", ["+1 United States", "+52 Mexico"]), job)).toEqual({ type: "option", option: "+1 United States" });
  expect(await adaptAnswer(llm, "United States of America", sel("Phone country", ["Canada (+1)", "United States (+1)"]), job)).toEqual({ type: "option", option: "United States (+1)" });
  expect(await adaptAnswer(llm, "+1", sel("Country code", ["Canada +1", "United States +1"]), job)).toEqual({ type: "option", option: "United States +1" });
  expect(llm.calls).toHaveLength(0);
});

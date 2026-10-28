import { expect, test } from "vitest";
import { distinctiveWords, entityProfileField, findOtherOption, followUpBox, isOtherOption, looksLikeFollowUp, otherEligible } from "../../src/answers/other.js";
import type { FieldSpec } from "../../src/forms/types.js";

const f = (label: string, kind: FieldSpec["kind"] = "select", extra: Partial<FieldSpec> = {}): FieldSpec => ({ id: label, label, kind, required: true, ...extra });
const text = (t: string) => ({ type: "text" as const, text: t });

test("findOtherOption picks the most specific 'Other' option, case-insensitively, and nothing else", () => {
  expect(findOtherOption(["Harvard", "Other", "Other school"])).toBe("Other school");
  expect(findOtherOption(["OTHER (please specify)", "Other"])).toBe("OTHER (please specify)");
  expect(findOtherOption(["Other - please specify"])).toBe("Other - please specify");
  expect(findOtherOption(["My school is not listed", "Not listed"])).toBe("My school is not listed");
  expect(findOtherOption(["None of the above", "Rice"])).toBe("None of the above");
  // Seen live: Greenhouse (Samsung) and Lever (Palantir) university lists.
  expect(findOtherOption(["0 - School Not Listed", "Aalborg University"])).toBe("0 - School Not Listed");
  expect(findOtherOption(["Other", "Other (School Not Listed)"])).toBe("Other (School Not Listed)");
  expect(findOtherOption(["Christian Brothers University", "Other"])).toBe("Other");
  expect(findOtherOption(["2020 Graduates", "10 Downing College"])).toBeNull();
  expect(findOtherOption(["Others", "Otherwise", "Mother Teresa College", "Brother Rice"])).toBeNull();
  expect(isOtherOption("Other university")).toBe(true);
  expect(isOtherOption("Rice University")).toBe(false);
});

test("only names may fall back to Other: entity profile keys, or bank/derived answers whose label asks for a name", () => {
  expect(otherEligible(f("School", "combobox"), { source: "profile", answer: text("Rice University"), entity: true })).toBe(true);
  expect(otherEligible(f("Which university do you attend?"), { source: "bank", answer: text("Rice University") })).toBe(true);
  expect(otherEligible(f("Current employer", "radio"), { source: "derived", answer: text("Acme") })).toBe(true);
  // Not names: never.
  expect(otherEligible(f("Are you authorized to work in the US?"), { source: "bank", answer: text("Authorized via OPT") })).toBe(false);
  expect(otherEligible(f("Are you authorized to work in the US?"), { source: "profile", answer: text("Rice"), entity: true })).toBe(false);
  expect(otherEligible(f("Gender"), { source: "profile", answer: text("Male"), entity: true })).toBe(false);
  expect(otherEligible(f("Which university requires sponsorship?"), { source: "bank", answer: text("Rice") })).toBe(false);
  expect(otherEligible(f("How did you hear about us?"), { source: "bank", answer: text("A friend") })).toBe(false);
  expect(otherEligible(f("School"), { source: "profile", answer: text("Yes"), entity: true })).toBe(false);
  expect(otherEligible(f("School", "text"), { source: "profile", answer: text("Rice University"), entity: true })).toBe(false);
  expect(otherEligible(f("School"), { source: "profile", answer: text("Rice University") })).toBe(false); // e.g. firstName

  expect(entityProfileField(f("School"), "school", "Rice University")).toBe(true);
  expect(entityProfileField(f("Country"), "country", "United States")).toBe(true);
  expect(entityProfileField(f("Country"), "country", "1234")).toBe(false);
  expect(entityProfileField(f("Are you willing to relocate?"), "willingToRelocate", true)).toBe(false);
  expect(entityProfileField(f("Race"), "ethnicity", "Hispanic or Latino")).toBe(false);
});

test("followUpBox finds the specify box right after the control; a handled field ends the search", () => {
  const school = f("School", "combobox");
  const specify = f("Please specify your school", "text");
  const plain = f("Untitled", "text");
  const email = f("Email", "email");
  const handled = (ids: string[]) => (id: string) => ids.includes(id);
  expect(followUpBox([school, specify, email], "School", handled(["School", "Email"]))).toBe(specify);
  expect(followUpBox([school, plain, email], "School", handled(["School", "Email"]))).toBe(plain); // new, right after
  expect(followUpBox([school, email, specify], "School", handled(["School", "Email"]))).toBeNull();
  expect(followUpBox([school, email], "School", handled(["School", "Email"]))).toBeNull();
  expect(looksLikeFollowUp([school, f("If other, school name", "text")], 1)).toBe(true);
  expect(looksLikeFollowUp([email, f("If other, school name", "text")], 1)).toBe(false);
  expect(looksLikeFollowUp([school, f("LinkedIn", "text")], 1)).toBe(false);
});

test("distinctiveWords keeps the words a search can find a name by", () => {
  expect(distinctiveWords("Rice University")).toEqual(["Rice"]);
  expect(distinctiveWords("University of Texas at Austin")).toEqual(["Texas", "Austin"]);
  expect(distinctiveWords("MIT")).toEqual(["MIT"]);
});

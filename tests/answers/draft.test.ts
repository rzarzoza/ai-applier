import { expect, test } from "vitest";
import { factAnswer } from "../../src/answers/draft.js";
import type { FieldSpec, JobContext } from "../../src/forms/types.js";
import { PROFILE_DEFAULTS, type Profile } from "../../src/profile/profile.js";
import { FakeLlm } from "../helpers/fake-llm.js";

const PROFILE: Profile = { ...PROFILE_DEFAULTS, firstName: "Luis", city: "Austin", state: "TX", country: "USA", willingToRelocate: true };
const JOB: JobContext = { jobId: "j1", company: "Acme", title: "Software Engineer Intern", location: "Atlanta, GA", term: "Summer 2027" };
const yesNo = (label: string): FieldSpec => ({ id: "f1", label, kind: "radio", required: true, options: ["Yes", "No"] });

/** Asks factAnswer `label` with the LLM replying `answer` on `basis`. */
async function ask(label: string, answer: string, basis: string, profile: Profile = PROFILE) {
  const llm = new FakeLlm().on("fact", () => ({ answerable: true, answer, basis }));
  return { llm, out: await factAnswer(llm, profile, label, yesNo(label), JOB) };
}

const NONE = { answerable: false, answer: null, basis: null };

test("the fact prompt carries the location and right-to-work rules", async () => {
  const { llm } = await ask("Are you located in Atlanta?", "No", "profile.city = Austin");
  const system = String(llm.calls[0]!.system);
  expect(system).toMatch(/answered ONLY from profile\.city, profile\.state, and profile\.country/);
  expect(system).toMatch(/Never answer it from profile\.willingToRelocate/);
  expect(system).toMatch(/explicitly offers relocation as an alternative/);
  expect(system).toMatch(/outside the applicant's country \(for example London or the UK for an applicant in the USA\), the question is not answerable/);
  expect(system).toMatch(/right-to-work.*country other than the applicant's country.*not answerable/s);
});

test("a relocation-based Yes to a location question outside the profile's country is rejected", async () => {
  const { out } = await ask(
    "Are you currently located in the Greater London area or will you relocate to London for this role?", "Yes", "profile.willingToRelocate = true");
  expect(out).toEqual(NONE);
});

test("a current-location question is never answered from willingToRelocate", async () => {
  expect((await ask("Are you located in or able to work in Atlanta?", "Yes", "profile.willingToRelocate = true")).out).toEqual(NONE);
  expect((await ask("Do you currently live within commuting distance of our Atlanta office?", "Yes", "profile.willingToRelocate = true")).out).toEqual(NONE);
  // Nor from anything but the profile's place fields.
  expect((await ask("Are you based in Texas?", "Yes", "resume: Austin, TX")).out).toEqual(NONE);
});

test("a current-location question answered from the profile's city/state/country stands", async () => {
  expect((await ask("Are you currently located in Texas?", "Yes", "profile.state = TX")).out)
    .toEqual({ answerable: true, answer: "Yes", basis: "profile.state = TX" });
  expect((await ask("Are you located in the Greater London area?", "No", "profile.city = Austin, profile.country = USA")).out)
    .toMatchObject({ answerable: true, answer: "No" });
});

test("relocation answers a combined located-or-relocate question only with a plain Yes inside the profile's country", async () => {
  const q = "Are you located in Atlanta, GA or willing to relocate to Atlanta?";
  expect((await ask(q, "Yes", "profile.willingToRelocate = true")).out).toEqual({ answerable: true, answer: "Yes", basis: "profile.willingToRelocate = true" });
  expect((await ask(q, "No", "profile.willingToRelocate = true")).out).toEqual(NONE);
  // With no country on the profile, a named place can't be checked: not answerable.
  expect((await ask(q, "Yes", "profile.willingToRelocate = true", { ...PROFILE, country: null })).out).toEqual(NONE);
  // Relocating abroad is never implied by a general willingness to relocate.
  expect((await ask("Are you willing to relocate to Toronto, Canada?", "Yes", "profile.willingToRelocate = true")).out).toEqual(NONE);
});

test("right-to-work questions about another country are not answerable; the profile's own country still is", async () => {
  expect((await ask("Do you have the right to work in the UK?", "Yes", "profile.workAuthorizedUS = true")).out).toEqual(NONE);
  expect((await ask("Will you require visa sponsorship to work in Germany?", "No", "profile.requiresSponsorship = false")).out).toEqual(NONE);
  expect((await ask("Are you legally authorized to work in the United States?", "Yes", "profile.workAuthorizedUS = true")).out)
    .toMatchObject({ answerable: true, answer: "Yes" });
  expect((await ask("Are you a U.S. citizen, U.S. national, lawful permanent resident, or protected individual?", "Yes", "profile.usCitizen = true")).out)
    .toMatchObject({ answerable: true, answer: "Yes" });
  expect((await ask("Are you legally able to work in the US without sponsorship?", "Yes", "profile.workAuthorizedUS = true")).out)
    .toMatchObject({ answerable: true, answer: "Yes" });
});

test("questions unrelated to place are untouched by the guard", async () => {
  expect((await ask("Have you ever worked for Acme?", "No", "profile.employers = [Onshape]")).out).toMatchObject({ answerable: true, answer: "No" });
});

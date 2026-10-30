import { describe, expect, test } from "vitest";
import { adaptAnswer } from "../../src/answers/adapt.js";
import { degreeCompatible, degreeInProgress, degreeQueries, isDegreeQuestion, parseDegree, pickDegree } from "../../src/answers/degree.js";
import type { FieldSpec, JobContext } from "../../src/forms/types.js";
import { FakeLlm } from "../helpers/fake-llm.js";

const job: JobContext = { jobId: "j1", company: "Acme", title: "SWE Intern", location: "Austin, TX", term: "Summer 2027" };
const degreeSelect = (options: string[], label = "Degree"): FieldSpec => ({ id: "d", label, kind: "select", required: true, options });
const noLlm = () => new FakeLlm();

describe("parseDegree", () => {
  test.each([
    ["B.S.", "bachelor", ["science"]], ["BS", "bachelor", ["science"]], ["B.Sc", "bachelor", ["science"]], ["BSc", "bachelor", ["science"]],
    ["B.A.", "bachelor", ["arts"]], ["BA", "bachelor", ["arts"]], ["B.Eng", "bachelor", ["engineering"]], ["BEng", "bachelor", ["engineering"]],
    ["Bachelor", "bachelor", []], ["Bachelors", "bachelor", []], ["Bachelor's", "bachelor", []], ["Bachelor’s Degree", "bachelor", []],
    ["Bachelor of Science", "bachelor", ["science"]], ["Bachelor of Arts", "bachelor", ["arts"]],
    ["Bachelor of Engineering", "bachelor", ["engineering"]], ["Bachelor of Science (BS)", "bachelor", ["science"]],
    ["BS/BA", "bachelor", ["science", "arts"]], ["Bachelor's (B.S./B.A.)", "bachelor", ["science", "arts"]],
    ["Undergraduate", "bachelor", []], ["Baccalaureate", "bachelor", []],
    ["M.S.", "master", ["science"]], ["MS", "master", ["science"]], ["MSc", "master", ["science"]], ["M.A.", "master", ["arts"]],
    ["MEng", "master", ["engineering"]], ["Master's", "master", []], ["Master of Science", "master", ["science"]],
    ["Masters Degree", "master", []], ["Graduate", "master", []], ["MBA", "master", ["business"]],
    ["Ph.D.", "doctorate", ["philosophy"]], ["PhD", "doctorate", ["philosophy"]], ["Doctorate", "doctorate", []],
    ["Doctor of Philosophy", "doctorate", ["philosophy"]],
    ["Associate's", "associate", []], ["Associate of Science", "associate", ["science"]], ["A.S.", "associate", ["science"]],
    ["High School", "high-school", []], ["High School Diploma or GED", "high-school", []], ["High school graduate", "high-school", []],
    ["Some college, no degree", "some-college", []],
  ])("%s → %s", (text, level, flavors) => {
    const d = parseDegree(text);
    expect(d?.level).toBe(level);
    expect([...d!.flavors].sort()).toEqual([...flavors].sort());
  });

  test("texts naming no single level parse to null", () => {
    for (const t of ["Other", "Computer Science", "Bachelor's or Master's", "Prefer not to say", "Yes", "as soon as possible", "N/A"]) {
      expect(parseDegree(t)).toBeNull();
    }
  });

  test("status: in progress vs completed", () => {
    expect(parseDegree("Currently pursuing a Bachelor's")?.status).toBe("in-progress");
    expect(parseDegree("Bachelor's (in progress)")?.status).toBe("in-progress");
    expect(parseDegree("Currently enrolled in a Bachelor's program")?.status).toBe("in-progress");
    expect(parseDegree("Bachelor's degree (completed)")?.status).toBe("completed");
    expect(parseDegree("Bachelor's Degree")?.status).toBeNull();
  });
});

describe("pickDegree", () => {
  test("B.S. picks the same level and flavor first", () => {
    expect(pickDegree("B.S.", ["Bachelor's Degree", "Bachelor of Science", "Master's Degree"])).toBe("Bachelor of Science");
    expect(pickDegree("B.S.", ["Bachelor of Arts", "Bachelor of Science (BS)", "Bachelor's Degree"])).toBe("Bachelor of Science (BS)");
  });

  test("B.S. falls back to a level-only option", () => {
    expect(pickDegree("B.S.", ["High School", "Associate's", "Bachelors Degree", "Masters Degree", "PhD", "Other"])).toBe("Bachelors Degree");
    expect(pickDegree("B.S.", ["Associate's Degree", "Bachelor's Degree", "Master's Degree"])).toBe("Bachelor's Degree");
    expect(pickDegree("B.S.", ["High School", "Undergraduate", "Graduate", "Other"])).toBe("Undergraduate");
    expect(pickDegree("B.S.", ["High School", "AA/AS", "BS/BA", "MS/MA", "PhD"])).toBe("BS/BA");
    expect(pickDegree("B.S.", ["High school", "Bachelor's (B.S./B.A.)", "Master's (M.S./M.A.)"])).toBe("Bachelor's (B.S./B.A.)");
    // A level-named option over a generic one, then the shortest.
    expect(pickDegree("B.S.", ["Undergraduate", "Bachelor's Degree", "Bachelor's"])).toBe("Bachelor's");
  });

  test("never another level, another flavor or an Other-like option", () => {
    expect(pickDegree("B.S.", ["Master's Degree", "Master of Science", "PhD", "Other"])).toBeNull();
    expect(pickDegree("B.S.", ["Bachelor of Arts", "Master of Science"])).toBeNull();
    expect(pickDegree("B.S.", ["Other", "Not listed", "Prefer not to say"])).toBeNull();
    expect(pickDegree("Master's", ["Bachelor's Degree", "Undergraduate"])).toBeNull();
    expect(pickDegree("Bachelor's or Master's", ["Bachelor's Degree"])).toBeNull();
  });

  test("a current student prefers the in-progress variant; a graduate never picks it", () => {
    const opts = ["Bachelor's Degree", "Currently pursuing a Bachelor's", "Master's Degree", "Currently pursuing a Master's"];
    expect(pickDegree("B.S.", opts, true)).toBe("Currently pursuing a Bachelor's");
    expect(pickDegree("B.S.", opts, false)).toBe("Bachelor's Degree");
    expect(pickDegree("B.S.", opts)).toBe("Bachelor's Degree");
    expect(pickDegree("B.S.", ["Bachelor's (completed)", "Bachelor's (in progress)", "Master's"], true)).toBe("Bachelor's (in progress)");
    expect(pickDegree("B.S.", ["Currently enrolled in a Bachelor's program", "Master's"], true)).toBe("Currently enrolled in a Bachelor's program");
    expect(pickDegree("B.S.", ["Currently pursuing a Bachelor's", "Master's"], false)).toBeNull();
    // Flavor still counts within the preferred status.
    expect(pickDegree("B.S.", ["Pursuing Bachelor of Arts", "Pursuing Bachelor of Science", "Bachelor of Science"], true)).toBe("Pursuing Bachelor of Science");
  });

  test("other levels map the same way", () => {
    expect(pickDegree("Ph.D.", ["Bachelors Degree", "Masters Degree", "Doctorate", "Other"])).toBe("Doctorate");
    expect(pickDegree("M.S.", ["Bachelor's", "Master of Science (MS)", "Master's", "PhD"])).toBe("Master of Science (MS)");
    expect(pickDegree("Master's", ["Undergraduate", "Graduate", "Doctorate"])).toBe("Graduate");
  });
});

test("isDegreeQuestion: by label, hint or a list of degree levels; only for a degree value", () => {
  expect(isDegreeQuestion("Degree", "B.S.", [])).toBe(true);
  expect(isDegreeQuestion("What is your highest level of education?", "B.S.", [])).toBe(true);
  expect(isDegreeQuestion("Education", "B.S.", ["High School", "Bachelor's", "Master's"])).toBe(true);
  expect(isDegreeQuestion("Anything else?", "B.S.", [], { degreeField: true })).toBe(true);
  expect(isDegreeQuestion("Degree", "Computer Science", ["Computer Science", "Math"])).toBe(false);
  expect(isDegreeQuestion("Anything else?", "B.S.", ["Yes", "No"])).toBe(false);
});

test("degreeCompatible rejects another level or flavor, allows unparsed text", () => {
  expect(degreeCompatible("B.S.", "Master's Degree")).toBe(false);
  expect(degreeCompatible("B.S.", "Bachelor of Arts")).toBe(false);
  expect(degreeCompatible("B.S.", "Bachelor's")).toBe(true);
  expect(degreeCompatible("B.S.", "4-year degree")).toBe(true);
});

test("degreeQueries and degreeInProgress", () => {
  expect(degreeQueries("B.S.")).toEqual(["Bachelor", "Undergraduate"]);
  expect(degreeQueries("Computer Science")).toEqual([]);
  const now = new Date(2026, 9, 28);
  expect(degreeInProgress("2028-05", now)).toBe(true);
  expect(degreeInProgress("2026-10", now)).toBe(true);
  expect(degreeInProgress("2025-05", now)).toBe(false);
  expect(degreeInProgress(null, now)).toBeNull();
});

describe("adaptAnswer on a degree field", () => {
  test("maps B.S. without the LLM", async () => {
    const llm = noLlm();
    const opts = ["High School", "Associate's", "Bachelors Degree", "Masters Degree", "PhD", "Other"];
    expect(await adaptAnswer(llm, "B.S.", degreeSelect(opts), job)).toEqual({ type: "option", option: "Bachelors Degree" });
    expect(await adaptAnswer(llm, "B.S.", degreeSelect(["Bachelor of Science", "Bachelor's Degree"]), job)).toEqual({ type: "option", option: "Bachelor of Science" });
    expect(await adaptAnswer(llm, "B.S.", { ...degreeSelect(["Undergraduate", "Graduate"], "Highest education completed"), kind: "radio" }, job))
      .toEqual({ type: "option", option: "Undergraduate" });
    expect(await adaptAnswer(llm, "B.S.", degreeSelect(["Bachelor's Degree", "Currently pursuing a Bachelor's"]), job, { inProgress: true }))
      .toEqual({ type: "option", option: "Currently pursuing a Bachelor's" });
    expect(llm.calls).toHaveLength(0);
  });

  test("the LLM is never allowed to pick another level or an Other-like option", async () => {
    const opts = ["Associate's", "Master's Degree", "Other"];
    const llm = new FakeLlm().on("adapt", () => ({ option: "Master's Degree" }));
    expect(await adaptAnswer(llm, "B.S.", degreeSelect(opts), job)).toBeNull();
    llm.on("adapt", () => ({ option: "Other" }));
    expect(await adaptAnswer(llm, "B.S.", degreeSelect(opts), job)).toBeNull();
  });

  test("a non-degree value in a degree-labelled field keeps the usual path", async () => {
    const llm = noLlm();
    expect(await adaptAnswer(llm, "Computer Science", degreeSelect(["Computer Science", "Mathematics"], "Degree discipline"), job))
      .toEqual({ type: "option", option: "Computer Science" });
  });
});

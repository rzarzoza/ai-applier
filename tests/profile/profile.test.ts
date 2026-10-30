import { expect, test } from "vitest";
import { openDb } from "../../src/db/db.js";
import { PROFILE_DEFAULTS, getProfile, profileValue, saveProfile } from "../../src/profile/profile.js";

test("defaults carry the user's stated answers", () => {
  const p = getProfile(openDb(":memory:"));
  expect(p).toMatchObject({ usCitizen: true, requiresSponsorship: false, hispanicLatino: true, disabilityStatus: "I do not want to answer" });
  expect(p.willingToRelocate).toBeNull();
});

test("saveProfile merges over stored values", () => {
  const db = openDb(":memory:");
  saveProfile(db, { city: "Austin" });
  expect(saveProfile(db, { state: "TX" })).toMatchObject({ city: "Austin", state: "TX" });
});

test("profileValue derives fullName, graduationYear and location", () => {
  const p = { ...PROFILE_DEFAULTS, firstName: "Luis", lastName: "Z", graduationMonth: "2028-05", city: "Austin", state: "TX" };
  expect(profileValue(p, "fullName")).toBe("Luis Z");
  expect(profileValue(p, "graduationYear")).toBe("2028");
  expect(profileValue(p, "location")).toBe("Austin, TX");
  expect(profileValue(PROFILE_DEFAULTS, "fullName")).toBeNull();
});

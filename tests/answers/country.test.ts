import { expect, test } from "vitest";
import { chooseOption, closestOptions, placeValue, searchQueries } from "../../src/answers/choose.js";
import { countryKey, countryQueries, dialCode, pickCountry } from "../../src/answers/country.js";

// Greenhouse's phone-country picker (seen live, Oct 2026): "<flag>Name +code", the United States first.
const GH = ["United States +1", "Afghanistan +93", "Åland Islands +358", "American Samoa +1", "Antigua & Barbuda +1", "Canada +1",
  "Mexico +52", "United Arab Emirates +971", "United Kingdom +44", "United States Minor Outlying Islands +1"];

test("every name of the United States is the same country", () => {
  for (const v of ["USA", "US", "U.S.", "U.S.A.", "United States", "united states of america", "America", "The United States"]) {
    expect(countryKey(v), v).toBe("united states");
    expect(pickCountry(v, GH), v).toBe("United States +1");
  }
  expect(countryKey("🇺🇸 United States (+1)")).toBe("united states");
  expect(countryKey("+1 United States")).toBe("united states");
  // A different territory is a different country.
  expect(countryKey("United States Minor Outlying Islands +1")).toBe("united states minor outlying islands");
});

test("other countries match under their other names and with or without a dialing code", () => {
  expect(pickCountry("UK", GH)).toBe("United Kingdom +44");
  expect(pickCountry("Great Britain", GH)).toBe("United Kingdom +44");
  expect(pickCountry("UAE", GH)).toBe("United Arab Emirates +971");
  expect(pickCountry("Mexico", GH)).toBe("Mexico +52");
  expect(pickCountry("Åland Islands", GH)).toBe("Åland Islands +358");
  expect(pickCountry("USA", ["+1 United States", "+52 Mexico"])).toBe("+1 United States");
  expect(pickCountry("United States", ["United States (+1)", "Canada (+1)"])).toBe("United States (+1)");
  expect(pickCountry("South Korea", ["Korea, Republic of", "Korea, Democratic People's Republic of"])).toBe("Korea, Republic of");
  expect(pickCountry("Narnia", GH)).toBeNull();
  expect(pickCountry("", GH)).toBeNull();
});

test("a bare dialing code picks the country it is home to", () => {
  expect(pickCountry("+1", GH)).toBe("United States +1");
  expect(pickCountry("1", ["Canada (+1)", "United States (+1)"])).toBe("United States (+1)");
  expect(pickCountry("+52", GH)).toBe("Mexico +52");
  expect(pickCountry("+44", GH)).toBe("United Kingdom +44");
  // A code shared by several countries, none of them its home: not guessed.
  expect(pickCountry("+1", ["Canada +1", "Jamaica +1"])).toBeNull();
  expect(dialCode("Antigua & Barbuda +1")).toBe("+1");
  expect(dialCode("United States")).toBeNull();
});

test("country queries search a picker by the name it lists", () => {
  expect(countryQueries("USA")).toEqual(["USA", "United States", "United"]);
  expect(searchQueries("USA", { label: "Country" })).toEqual(["USA", "United States", "United"]);
});

test("chooseOption: exact, then places, countries, degrees and a unique prefix — never a guess", () => {
  const ctx = { label: "Country" };
  expect(chooseOption("USA", GH, ctx)).toEqual({ option: "United States +1", sure: false });
  expect(chooseOption("Mexico +52", GH, ctx)).toEqual({ option: "Mexico +52", sure: true });

  const places = ["Houston, Texas, United States", "South Houston, Texas, United States", "Houston, Scotland, United Kingdom",
    "Houston, Mississippi, United States", "Houston, British Columbia, Canada"];
  const loc = { label: "Location (City)" };
  expect(chooseOption("Houston, Texas", places, loc)).toEqual({ option: "Houston, Texas, United States", sure: false });
  // A bare city with several Houstons is ambiguous...
  expect(chooseOption("Houston", places, loc)).toBeNull();
  // ...until the profile's state makes it the Houston in Texas.
  const hint = { city: "Houston", state: "Texas", country: "USA" };
  expect(placeValue("Location (City)", "Houston", hint)).toBe("Houston, Texas");
  expect(chooseOption(placeValue("Location (City)", "Houston", hint), places, loc)?.option).toBe("Houston, Texas, United States");
  expect(placeValue("Location (City)", "Austin", hint)).toBe("Austin");
  expect(placeValue("Why this role?", "Houston", hint)).toBe("Houston");
  expect(searchQueries("Houston, Texas", loc)).toEqual(["Houston, Texas", "Houston", "Houston, TX"]);

  const degrees = ["High School", "Associate's Degree", "Bachelor's Degree", "Master's Degree", "Doctorate"];
  expect(chooseOption("B.S.", degrees, { label: "Degree" })).toEqual({ option: "Bachelor's Degree", sure: false });
  expect(chooseOption("Computer", ["Computer Science", "Computer Engineering"], { label: "Discipline" })).toBeNull();
  expect(chooseOption("Computer Sci", ["Computer Science", "Computer Engineering"], { label: "Discipline" })?.option).toBe("Computer Science");
  // "Yes" is never taken for a qualified yes.
  expect(chooseOption("Yes", ["Yes, but I need sponsorship", "No"], { label: "Authorized?" })).toBeNull();
  expect(chooseOption("Yes", ["Yes", "No"], { label: "Authorized?" })).toEqual({ option: "Yes", sure: true });
});

test("closestOptions offers the likeliest options first", () => {
  expect(closestOptions("USA", GH, 3)).toEqual(["United States +1", "Afghanistan +93", "Åland Islands +358"]);
  expect(closestOptions("Houston", ["Austin, Texas", "Houston, Texas, United States", "Dallas, Texas"], 2)).toEqual(["Houston, Texas, United States", "Austin, Texas"]);
  expect(closestOptions("Rice University", ["Harvard University", "Rice University (Houston)", "MIT"], 2)).toEqual(["Rice University (Houston)", "Harvard University"]);
});

import { expect, test } from "vitest";
import { inferCountry } from "../../src/filters/country.js";

test.each([
  ["Seattle, WA", "USA"], ["NYC", "USA"], ["SF", "USA"], ["LA", "USA"], ["Remote in USA", "USA"],
  ["United States", "USA"], ["Washington, DC", "USA"], ["Toronto, ON, Canada", "Canada"],
  ["Kanata, Ottawa, ON, Canada", "Canada"], ["Remote in Canada", "Canada"], ["Vancouver, BC", "Canada"],
  ["London, UK", "UK"], ["Bangalore, India", "India"], ["Remote", "Unknown"], ["Mars Base 1", "Unknown"],
])("inferCountry(%s) = %s", (loc, c) => expect(inferCountry(loc)).toBe(c));

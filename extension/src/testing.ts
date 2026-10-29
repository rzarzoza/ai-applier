/**
 * Test-only entry: the content script's DOM pieces on `window.__aa`, so Playwright tests can inject one bundle into a
 * fixture page and drive the same scan and fill code the extension runs (without the chrome.* APIs).
 */
import type { ExtAnswer } from "../../src/ext/protocol.js";
import { collectFields } from "../../src/forms/collect.js";
import type { FieldSpec } from "../../src/forms/types.js";
import { fillField, readValue } from "./fill.js";
import { findFormScope, isApplicationPage, markScope } from "./scope.js";

const resume = async () => new File([new Uint8Array([37, 80, 68, 70, 45])], "Luis_Hernandez_Resume.pdf", { type: "application/pdf" });

const api = {
  collect: (scope: string) => collectFields(scope),
  scope(min = 3, allowBody = true): string | null {
    const el = findFormScope(min, allowBody);
    return el ? markScope(el) : null;
  },
  fill: (field: FieldSpec, answer: ExtAnswer) => fillField(field, answer, { resume, optionWaitMs: 1000 }),
  read: (field: FieldSpec) => readValue(field),
  isApplicationPage: (url: string) => isApplicationPage(new URL(url)),
};

(window as unknown as { __aa: typeof api }).__aa = api;
export type AaTestApi = typeof api;

/**
 * Test-only entry: the content script's DOM pieces on `window.__aa`, so Playwright tests can inject one bundle into a
 * fixture page and drive the same scan and fill code the extension runs (without the chrome.* APIs). A test stands in
 * for the app's /ext/adapt by setting `window.__aaAdapt` (it records what was asked in `window.__aaAdaptCalls`).
 */
import type { AdaptResponse, ExtAnswer, ExtHints } from "../../src/ext/protocol.js";
import { collectFields } from "../../src/forms/collect.js";
import type { FieldSpec } from "../../src/forms/types.js";
import { fillField, readValue, type AdaptCall } from "./fill.js";
import { parsing } from "./parse.js";
import { refineFields } from "./refine.js";
import { findFormScope, isApplicationPage, markScope } from "./scope.js";
import { manualSections } from "./sections.js";

const resume = async () => new File([new Uint8Array([37, 80, 68, 70, 45])], "Luis_Hernandez_Resume.pdf", { type: "application/pdf" });

type W = { __aaAdapt?: (c: AdaptCall) => AdaptResponse | null; __aaAdaptCalls?: AdaptCall[]; __aaHints?: ExtHints };
const w = window as unknown as W;

const api = {
  collect: (scope: string) => refineFields(collectFields(scope), document.querySelector(scope)),
  scope(min = 3, allowBody = true): string | null {
    const el = findFormScope(min, allowBody);
    return el ? markScope(el) : null;
  },
  fill: (field: FieldSpec, answer: ExtAnswer, waitMs = 1000) => fillField(field, answer, {
    resume, optionWaitMs: waitMs, hints: w.__aaHints ?? null,
    adapt: async c => {
      (w.__aaAdaptCalls ??= []).push(JSON.parse(JSON.stringify(c)) as AdaptCall);
      return w.__aaAdapt ? w.__aaAdapt(c) : null;
    },
  }),
  read: (field: FieldSpec) => readValue(field),
  isApplicationPage: (url: string) => isApplicationPage(new URL(url)),
  manual: (scope?: string) => manualSections(scope ? document.querySelector(scope) : null).map(m => m.label),
  parsing: () => parsing(null),
};

(window as unknown as { __aa: typeof api }).__aa = api;
export type AaTestApi = typeof api;

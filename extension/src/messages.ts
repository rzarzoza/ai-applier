import type { LearnRequest, SubmittedRequest } from "../../src/ext/protocol.js";

/** Messages from the content script and the popup to the background service worker. */
export type BgRequest =
  | { type: "api"; method: "GET" | "POST"; path: string; body?: unknown }
  | { type: "resume" }
  /** The user clicked submit: learn + submitted go out after `delayMs` unless cancelled (the form refused it). */
  | { type: "submit"; id: string; learn: LearnRequest | null; submitted: SubmittedRequest; delayMs: number }
  | { type: "submit-cancel"; id: string }
  | { type: "submit-commit"; id: string }
  | { type: "get-config" }
  | { type: "set-config"; token?: string; apiBase?: string }
  | { type: "site-paused"; host: string; paused?: boolean };

/** Messages from the popup to a tab's content scripts. */
export type TabRequest = { type: "fill" } | { type: "state" };
export interface TabState { active: boolean; filled: number; total: number; left: number }

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export interface Config { token: string; apiBase: string; pausedHosts: string[] }

export interface ResumeFile { name: string; type: string; base64: string }

/** A submission waiting to be sent to the app (kept in storage so a page that navigates away doesn't lose it). */
export interface PendingSubmit {
  id: string; due: number; tries: number;
  learn: LearnRequest | null; learnDone: boolean;
  submitted: SubmittedRequest;
}

export const send = <T>(msg: BgRequest): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;

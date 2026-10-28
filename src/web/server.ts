import { Hono } from "hono";
import { answerQuestion } from "../answers/inbox.js";
import { getQuestion, setDraft } from "../answers/bank.js";
import { reviseDraft } from "../answers/draft.js";
import type { Db } from "../db/db.js";
import type { Llm } from "../llm/llm.js";
import { getProfile } from "../profile/profile.js";
import { CardFragment, InboxPage, OpeningBrowser, SavedNotice } from "./pages/inbox.js";

export interface AppContext {
  db: Db;
  llm: Llm;
  runInteractive(jobId: string): void;
  pollNow(): void;
}

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  const { db } = ctx;
  const card = (id: number, error?: string) => CardFragment({ db, id, error });

  app.get("/", c => c.redirect("/inbox"));
  app.get("/inbox", c => c.html(InboxPage({ db })));

  app.post("/inbox/:id/answer", async c => {
    const id = Number(c.req.param("id"));
    if (!getQuestion(db, id)) return c.text("Unknown question", 404);
    const form = await c.req.parseBody();
    const text = typeof form.text === "string" ? form.text.trim() : "";
    if (!text) return c.html(card(id, "Type an answer first."));
    const kind = form.kind === "template" || form.kind === "global" ? form.kind : form.kindChoice ? "global" : undefined;
    const { requeued } = answerQuestion(db, id, text, kind);
    return c.html(SavedNotice({ requeued: requeued.length }));
  });

  app.post("/inbox/:id/use-draft", c => {
    const id = Number(c.req.param("id"));
    const q = getQuestion(db, id);
    if (!q) return c.text("Unknown question", 404);
    if (!q.draft) return c.html(card(id, "There is no draft to use."));
    const { requeued } = answerQuestion(db, id, q.draft);
    return c.html(SavedNotice({ requeued: requeued.length }));
  });

  app.post("/inbox/:id/revise", async c => {
    const id = Number(c.req.param("id"));
    const q = getQuestion(db, id);
    if (!q) return c.text("Unknown question", 404);
    const form = await c.req.parseBody();
    const instruction = typeof form.instruction === "string" ? form.instruction.trim() : "";
    if (!q.draft || !instruction) return c.html(card(id, "Tell the AI what to change."));
    try {
      setDraft(db, id, await reviseDraft(ctx.llm, getProfile(db), q.canonical, q.draft, instruction));
    } catch (e) {
      return c.html(card(id, `Couldn't revise the draft: ${e instanceof Error ? e.message : String(e)}`));
    }
    return c.html(card(id));
  });

  app.post("/needs-you/:jobId/do-it-now", c => {
    ctx.runInteractive(c.req.param("jobId"));
    return c.html(OpeningBrowser());
  });

  return app;
}

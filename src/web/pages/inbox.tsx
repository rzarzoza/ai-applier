import type { Db } from "../../db/db.js";
import { listOpenNeedsYou } from "../../answers/bank.js";
import { inboxItems, type InboxItem } from "../../answers/inbox.js";
import { Layout } from "../layout.js";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function inboxCount(db: Db): number {
  return inboxItems(db).length + listOpenNeedsYou(db).length;
}

export function SavedNotice(props: { requeued: number }) {
  return <div class="card saved">Saved · {plural(props.requeued, "job", "jobs")} re-queued</div>;
}

export function QuestionCard(props: { item: InboxItem; error?: string }) {
  const { question: q, jobs } = props.item;
  const companies = jobs.map(j => j.company);
  const shown = companies.slice(0, 3).join(", ") + (companies.length > 3 ? `, +${companies.length - 3}` : "");
  const approved = q.status === "approved";
  const current = approved ? q.answer ?? "" : q.draft ?? "";
  const hasDraft = !approved && !!q.draft;
  const field = q.options
    ? (
      <select name="text">
        {q.options.map(o => <option value={o} selected={o === current}>{o}</option>)}
      </select>
    )
    : <textarea name="text" required>{current}</textarea>;
  const answerForm = (
    <form hx-post={`/inbox/${q.id}/answer`} hx-target={`#q-${q.id}`} hx-swap="outerHTML">
      {field}
      {q.kind === "template" ? (
        <label class="meta">
          <input type="hidden" name="kindChoice" value="1" />
          <input type="checkbox" name="kind" value="template" checked /> Save as template
        </label>
      ) : null}
      <div class="row"><button class="primary" type="submit">Save answer</button></div>
    </form>
  );
  return (
    <div class="card" id={`q-${q.id}`}>
      <h3>{q.canonical}</h3>
      <div class="meta">Blocking {plural(jobs.length, "job", "jobs")} · {shown}</div>
      {q.variants.length > 0 ? <div class="meta">Also asked as: {q.variants.join(" · ")}</div> : null}
      {approved ? <div class="note">Your saved answer didn't fit this form — answer again</div> : null}
      {props.error ? <div class="note">{props.error}</div> : null}
      {hasDraft ? (
        <>
          <div class="draft">{q.draft}</div>
          <div class="row">
            <button class="primary" hx-post={`/inbox/${q.id}/use-draft`} hx-target={`#q-${q.id}`} hx-swap="outerHTML">Use draft</button>
          </div>
          <details>
            <summary>Edit</summary>
            {answerForm}
          </details>
          <details>
            <summary>Tell AI what to change</summary>
            <form hx-post={`/inbox/${q.id}/revise`} hx-target={`#q-${q.id}`} hx-swap="outerHTML">
              <input type="text" name="instruction" placeholder="e.g. make it shorter" required />
              <div class="row"><button type="submit">Revise</button></div>
            </form>
          </details>
        </>
      ) : answerForm}
    </div>
  );
}

export function InboxPage(props: { db: Db }) {
  const items = inboxItems(props.db);
  const needs = listOpenNeedsYou(props.db);
  return (
    <Layout active="inbox" inboxCount={items.length + needs.length}>
      <h1>Inbox</h1>
      {items.length === 0 ? <p class="empty">No questions waiting. Nothing is blocked on you.</p> : items.map(item => <QuestionCard item={item} />)}
      <h2>Needs you</h2>
      {needs.length === 0 ? <p class="empty">Nothing needs you right now.</p> : needs.map(n => (
        <div class="card" id={`needs-${n.id}`}>
          <strong>{n.kind}</strong>
          <div class="meta">{n.message}</div>
          <div class="row">
            <button class="primary" hx-post={`/needs-you/${n.jobId}/do-it-now`} hx-target={`#needs-${n.id}`} hx-swap="innerHTML">Do it now</button>
          </div>
        </div>
      ))}
    </Layout>
  );
}

/** The re-rendered card for one question, or the saved notice if it no longer blocks anything. */
export function CardFragment(props: { db: Db; id: number; error?: string }) {
  const item = inboxItems(props.db).find(i => i.question.id === props.id);
  return item ? <QuestionCard item={item} error={props.error} /> : <SavedNotice requeued={0} />;
}

export function OpeningBrowser() {
  return <span>Opening browser…</span>;
}

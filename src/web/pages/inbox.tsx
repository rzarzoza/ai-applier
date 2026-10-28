import { raw } from "hono/html";
import type { Db } from "../../db/db.js";
import { listOpenNeedsYou, type Question } from "../../answers/bank.js";
import { blockerOptions, canDoItNow, inboxItems, type BlockedJob, type InboxItem } from "../../answers/inbox.js";
import type { FieldKind } from "../../forms/types.js";
import { Layout, pauseProps } from "../layout.js";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function inboxCount(db: Db): number {
  return inboxItems(db).length + listOpenNeedsYou(db).length;
}

export function SavedNotice(props: { requeued: number }) {
  return <div class="card saved">Saved · {plural(props.requeued, "job", "jobs")} re-queued</div>;
}

const KIND_NAMES: Record<FieldKind, string> = {
  text: "Short text", textarea: "Long text", email: "Email", tel: "Phone number", url: "Link", number: "Number", date: "Date",
  select: "Dropdown (pick one)", combobox: "Searchable dropdown (pick one)", radio: "Pick one", checkbox: "Checkbox",
  "checkbox-group": "Checkboxes (pick any)", file: "File upload",
};

// Static script (no user text), injected verbatim. It copies the text of the quoted label next to the
// clicked Copy button; delegated so cards swapped in by htmx work too.
const COPY_SCRIPT = `
document.addEventListener("click", function (e) {
  var b = e.target && e.target.closest ? e.target.closest("[data-copy]") : null;
  if (!b) return;
  var t = b.parentElement && b.parentElement.querySelector(".field-label");
  if (!t || !navigator.clipboard) return;
  navigator.clipboard.writeText(t.textContent).then(function () {
    b.textContent = "Copied";
    setTimeout(function () { b.textContent = "Copy"; }, 1500);
  });
});
`;

/** One blocked job: where to find the question, and the form's own wording, section, type and choices. */
function BlockedField(props: { q: Question; job: BlockedJob }) {
  const { q, job: j } = props;
  const options = blockerOptions(q, j);
  return (
    <div class="blocked">
      <div class="meta">
        <strong>{j.company}</strong> · {j.title}
        {/^https?:\/\//i.test(j.url) ? <> · <a href={j.url} target="_blank" rel="noopener">Open posting</a></> : null}
      </div>
      {j.label
        ? (
          <div class="quote-row">
            <blockquote class="field-label">{j.label}</blockquote>
            <button type="button" class="copy" data-copy>Copy</button>
          </div>
        )
        : <div class="meta">The form's exact wording wasn't recorded for this job. Use “Re-check with my profile” to record it.</div>}
      {j.description ? <div class="meta">Section / help text: {j.description}</div> : null}
      {j.kind ? <div class="meta">Field type: {KIND_NAMES[j.kind] ?? j.kind}</div> : null}
      {options?.length ? <div class="meta">Choices: {options.join(" · ")}</div> : null}
    </div>
  );
}

export function QuestionCard(props: { item: InboxItem; error?: string }) {
  const { question: q, jobs } = props.item;
  const companies = jobs.map(j => j.company);
  const shown = companies.slice(0, 3).join(", ") + (companies.length > 3 ? `, +${companies.length - 3}` : "");
  const approved = q.status === "approved";
  const current = approved ? q.answer ?? "" : q.draft ?? "";
  const hasDraft = !approved && !!q.draft;
  // Each blocking form may offer different options; one list when they agree, else a choice per job.
  const lists = jobs.map(j => blockerOptions(q, j));
  const shared = lists.every(l => JSON.stringify(l) === JSON.stringify(lists[0])) ? lists[0] ?? null : undefined;
  const savedNotOffered = approved && q.answer !== null && !!shared && !shared.some(o => o.trim().toLowerCase() === q.answer!.trim().toLowerCase());
  const field = shared
    ? (
      <select name="text">
        {shared.map(o => <option value={o} selected={o === current}>{o}</option>)}
      </select>
    )
    : <textarea name="text" required={shared === null}>{current}</textarea>;
  const perJob = shared === undefined ? jobs.filter((j, i) => lists[i] && j.label) : [];
  const answerForm = (
    <form hx-post={`/inbox/${q.id}/answer`} hx-target={`#q-${q.id}`} hx-swap="outerHTML">
      {field}
      {perJob.length > 0 ? (
        <div>
          <div class="meta">These forms offer different options. Pick one per job, or leave it to the answer above:</div>
          {perJob.map(j => (
            <label class="meta">
              {j.company} · {j.title}
              <select name={`choice:${j.id}`}>
                <option value="">Use the answer above</option>
                {lists[jobs.indexOf(j)]!.map(o => <option value={o}>{o}</option>)}
              </select>
            </label>
          ))}
        </div>
      ) : null}
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
      {savedNotOffered
        ? <div class="note">Your saved answer “{q.answer}” isn't an option on {jobs.length === 1 ? "this form" : "these forms"} — what you pick is used for {jobs.length === 1 ? "this job" : "these jobs"} only</div>
        : approved ? <div class="note">Your saved answer didn't fit this form — answer again</div> : null}
      {jobs.map(j => <BlockedField q={q} job={j} />)}
      {props.error ? <div class="note">{props.error}</div> : null}
      {hasDraft ? (
        <>
          <div class="meta">Suggested from your profile/resume:</div>
          <div class="draft">{q.draft}</div>
          {q.draftBasis ? <div class="meta">Based on: {q.draftBasis}</div> : null}
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

export function InboxPage(props: { db: Db; rechecked?: number }) {
  const items = inboxItems(props.db);
  const needs = listOpenNeedsYou(props.db);
  return (
    <Layout active="inbox" inboxCount={items.length + needs.length} {...pauseProps(props.db)}>
      <h1>Inbox</h1>
      {props.rechecked !== undefined
        ? <div class="card saved">Re-checking {plural(props.rechecked, "job", "jobs")} with your profile and resume · queued to run again</div>
        : null}
      {items.length > 0 ? (
        <form method="post" action="/inbox/recheck" class="row">
          <button type="submit">Re-check with my profile</button>
          <span class="meta">Runs the blocked jobs again so answers your profile or resume now gives are suggested for approval.</span>
        </form>
      ) : null}
      {items.length === 0 ? <p class="empty">No questions waiting. Nothing is blocked on you.</p> : items.map(item => <QuestionCard item={item} />)}
      <h2>Needs you</h2>
      {needs.length === 0 ? <p class="empty">Nothing needs you right now.</p> : needs.map(n => (
        <div class="card" id={`needs-${n.id}`}>
          <strong>{n.kind}</strong>
          <div class="meta">{n.message}</div>
          <div class="row">
            {canDoItNow(props.db, n.jobId)
              ? <button class="primary" hx-post={`/needs-you/${n.jobId}/do-it-now`} hx-target={`#needs-${n.id}`} hx-swap="innerHTML">Do it now</button>
              : <a href={`/applications/${n.jobId}`}>Open job</a>}
          </div>
        </div>
      ))}
      <script>{raw(COPY_SCRIPT)}</script>
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

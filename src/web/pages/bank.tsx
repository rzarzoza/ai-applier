import { getSettings } from "../../settings.js";
import { listQuestions, type Question } from "../../answers/bank.js";
import type { Db } from "../../db/db.js";
import { Layout } from "../layout.js";
import { inboxCount } from "./inbox.js";

function BankRow(props: { q: Question }) {
  const { q } = props;
  const current = q.answer ?? q.draft ?? "";
  return (
    <div class="card" id={`bank-${q.id}`}>
      <h3>{q.canonical}</h3>
      <div class="meta">{q.status} · {q.kind} · used {q.useCount} {q.useCount === 1 ? "time" : "times"}</div>
      {q.variants.length > 0 ? <div class="meta">Also asked as: {q.variants.join(" · ")}</div> : null}
      <form method="post" action={`/bank/${q.id}`}>
        {q.options
          ? <select name="answer">{q.options.map(o => <option value={o} selected={o === current}>{o}</option>)}</select>
          : <textarea name="answer" required>{current}</textarea>}
        <div class="row">
          <select name="kind" style="width:auto">
            <option value="global" selected={q.kind === "global"}>Same answer everywhere</option>
            <option value="template" selected={q.kind === "template"}>Template (adapt per company)</option>
          </select>
          <button class="primary" type="submit">Save &amp; approve</button>
          <button type="submit" formaction={`/bank/${q.id}/delete`} formnovalidate>Delete</button>
        </div>
      </form>
    </div>
  );
}

export function BankPage(props: { db: Db; search?: string }) {
  const items = listQuestions(props.db, { search: props.search || undefined });
  return (
    <Layout active="bank" inboxCount={inboxCount(props.db)} paused={getSettings(props.db).paused}>
      <h1>Answer bank</h1>
      <form method="get" action="/bank" class="row">
        <input type="text" name="search" value={props.search ?? ""} placeholder="Search questions" />
        <button type="submit">Search</button>
      </form>
      {items.length === 0 ? <p class="empty">No questions yet.</p> : items.map(q => <BankRow q={q} />)}
    </Layout>
  );
}

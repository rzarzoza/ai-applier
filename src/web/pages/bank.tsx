import { listQuestions, type Question } from "../../answers/bank.js";
import type { Db } from "../../db/db.js";
import { Layout, pauseProps } from "../layout.js";
import { Chip, PageHead } from "../ui.js";
import { inboxCount } from "./inbox.js";

const STATUS_NAMES: Record<Question["status"], string> = { approved: "Approved", draft: "Draft", none: "No answer" };

function BankRow(props: { q: Question }) {
  const { q } = props;
  const current = q.answer ?? q.draft ?? "";
  return (
    <div class="card" id={`bank-${q.id}`}>
      <h3>{q.canonical}</h3>
      <div class="meta">
        <Chip cls={q.status === "approved" ? "chip-green" : q.status === "draft" ? "chip-amber" : "chip-gray"}>{STATUS_NAMES[q.status]}</Chip>{" "}
        {q.kind === "template" ? "Template" : "Same everywhere"} · used {q.useCount} {q.useCount === 1 ? "time" : "times"}
      </div>
      {q.variants.length > 0 ? <div class="meta">Also asked as: {q.variants.join(" · ")}</div> : null}
      <form method="post" action={`/bank/${q.id}`}>
        {q.options
          ? <select name="answer">{q.options.map(o => <option value={o} selected={o === current}>{o}</option>)}</select>
          : <textarea name="answer" required>{current}</textarea>}
        <div class="row">
          <select name="kind" style="width:auto;max-width:100%">
            <option value="global" selected={q.kind === "global"}>Same answer everywhere</option>
            <option value="template" selected={q.kind === "template"}>Template (adapt per company)</option>
          </select>
          <button class="primary" type="submit">Save &amp; approve</button>
          <button type="submit" class="tertiary" formaction={`/bank/${q.id}/delete`} formnovalidate>Delete</button>
        </div>
      </form>
    </div>
  );
}

export function BankPage(props: { db: Db; search?: string }) {
  const items = listQuestions(props.db, { search: props.search || undefined });
  return (
    <Layout active="bank" inboxCount={inboxCount(props.db)} {...pauseProps(props.db)} title="Answer bank">
      <PageHead title="Answer bank" subtitle="Your saved answers, reused across every application." />
      <form method="get" action="/bank" class="card row" style="margin-top:0;flex-wrap:nowrap">
        <input type="search" name="search" value={props.search ?? ""} placeholder="Search questions" aria-label="Search questions" />
        <button type="submit">Search</button>
      </form>
      {items.length === 0 ? <div class="card"><p class="empty">No questions yet.</p></div> : items.map(q => <BankRow q={q} />)}
    </Layout>
  );
}

import type { FC } from "hono/jsx";
import { many, one, type Db } from "../../db/db.js";
import { getDncState, type DncState } from "../../pipeline/dnc.js";
import { getKnownState, KNOWN_LABEL, type KnownKind, type KnownState } from "../../pipeline/known.js";
import { decideLeads, markNotDuplicate, ReviewError, type Decision } from "../../reviews.js";
import type { Session } from "../../auth.js";
import { can, idParam, list, need, ok, refererPath, str, type App, type Deps } from "../http.js";
import { Chip, count, Csrf, day, Page, Pager, phone, render, statusLabel, when } from "../views.js";

const STATUSES = ["in_review", "approved", "rejected", "exported", "duplicate", "in_vici", "in_close", "blocked_dnc", "invalid"];
// Statuses the automatic checks put a lead in. No person decided these.
export const HELD = ["duplicate", "in_vici", "in_close", "blocked_dnc", "invalid"];
// A lead "needs info" while it is still in review and the last thing a reviewer did was ask for more.
export const NEEDS_INFO = "((SELECT d.decision FROM audit_decisions d WHERE d.lead_id = l.id ORDER BY d.id DESC LIMIT 1) = 'needs_info') IS TRUE";
const PASSED = ["in_review", "approved", "rejected"];
const PAGE_SIZE = 50;

const TABS = [
  ["in_review", "To review"],
  ["needs_info", "Needs info"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["held", "Held back"],
  ["all", "All"],
] as const;
type Tab = (typeof TABS)[number][0];

const TAB_WHERE: Record<Tab, string> = {
  in_review: `l.status = 'in_review' AND NOT ${NEEDS_INFO}`,
  needs_info: `l.status = 'in_review' AND ${NEEDS_INFO}`,
  approved: "l.status = 'approved'",
  rejected: "l.status = 'rejected'",
  held: `l.status IN (${HELD.map((status) => `'${status}'`).join(", ")})`,
  all: "TRUE",
};

type LeadRow = {
  id: number;
  run_id: number;
  business_name: string | null;
  phone_e164: string | null;
  phone_raw: string | null;
  website: string | null;
  website_domain: string | null;
  email: string | null;
  owner_name: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  category: string | null;
  status: string;
  status_reason: string | null;
  dnc_checked_at: Date | null;
  created_at: Date;
  source: string;
  needs_info: boolean;
  note: string | null;
};

type Match = {
  match_type: string;
  matched_ref: string;
  matched_lead_id: number | null;
  rule_used: string;
  other_name: string | null;
  list_name: string | null;
};

type Detail = {
  lead: LeadRow & { payload_json: Record<string, string> | null };
  matches: Match[];
  decisions: { decision: string; reason: string | null; created_at: Date; name: string }[];
  batches: { id: number; name: string; status: string }[];
};

async function loadDetail(db: Db, leadId: number): Promise<Detail | null> {
  const lead = await one<Detail["lead"]>(
    db,
    `SELECT l.*, s.name AS source, w.payload_json, ${NEEDS_INFO} AS needs_info,
            (SELECT d.reason FROM audit_decisions d WHERE d.lead_id = l.id ORDER BY d.id DESC LIMIT 1) AS note
     FROM leads l JOIN runs r ON r.id = l.run_id JOIN sources s ON s.id = r.source_id
     LEFT JOIN raw_records w ON w.id = l.source_record_id WHERE l.id = $1`,
    [leadId],
  );
  if (!lead) return null;
  const matches = await many<Match>(
    db,
    `SELECT m.match_type, m.matched_ref, m.matched_lead_id, m.rule_used, o.business_name AS other_name,
            coalesce((SELECT d.name FROM dnc_lists d WHERE 'dnc_list:' || d.id = m.matched_ref),
                     (SELECT k.name FROM known_lists k WHERE 'known_list:' || k.id = m.matched_ref)) AS list_name
     FROM dedupe_matches m LEFT JOIN leads o ON o.id = m.matched_lead_id WHERE m.lead_id = $1 ORDER BY m.id`,
    [leadId],
  );
  const decisions = await many<Detail["decisions"][number]>(
    db,
    `SELECT d.decision, d.reason, d.created_at, u.name FROM audit_decisions d
     JOIN users u ON u.id = d.reviewer_user_id WHERE d.lead_id = $1 ORDER BY d.id DESC`,
    [leadId],
  );
  const batches = await many<Detail["batches"][number]>(
    db,
    `SELECT e.id, e.name, e.status FROM export_batch_leads b JOIN export_batches e ON e.id = b.batch_id WHERE b.lead_id = $1`,
    [leadId],
  );
  return { lead, matches, decisions, batches };
}

type Check = { label: string; tone: string; text: string; href?: string };

// What each automatic check found for one lead. "ok" is only claimed where the check is known to
// have run against something; everything else says what was not done.
function checksFor(detail: Detail, dnc: DncState, known: KnownState): Check[] {
  const { lead, matches } = detail;
  const passed = PASSED.includes(lead.status);
  const rule = (value: string) => value.replace("name_city", "name and city").replace("domain", "website");
  const checks: Check[] = [];

  const internal = matches.filter((match) => match.match_type === "internal");
  if (lead.status === "duplicate" && internal.length > 0) {
    const first = internal[0]!;
    checks.push({
      label: "Duplicate",
      tone: "bad",
      text: first.matched_lead_id ? `Same ${rule(first.rule_used)} as #${first.matched_lead_id} ${first.other_name ?? ""}` : `Same ${rule(first.rule_used)} as an earlier lead`,
      ...(first.matched_lead_id ? { href: `/leads/${first.matched_lead_id}` } : {}),
    });
  } else if (passed || lead.status === "exported") {
    checks.push({ label: "Duplicate", tone: "ok", text: internal.length > 0 ? "A reviewer said this is a different business" : "No match in its file or earlier imports" });
  } else {
    checks.push({ label: "Duplicate", tone: "", text: "No duplicate match recorded" });
  }

  for (const kind of ["vici", "close"] as KnownKind[]) {
    const label = KNOWN_LABEL[kind];
    const hit = matches.find((match) => match.match_type === kind);
    if (lead.status === (kind === "vici" ? "in_vici" : "in_close")) {
      checks.push({ label, tone: "bad", text: hit?.list_name ? `Found in the file "${hit.list_name}"` : (lead.status_reason ?? `Found in a ${label} file`) });
    } else if (known[kind].lists === 0) {
      checks.push({ label, tone: "warn", text: "Not compared. No export loaded" });
    } else if (!lead.phone_e164) {
      checks.push({ label, tone: "", text: "No valid phone number to compare" });
    } else if (passed) {
      checks.push({ label, tone: "ok", text: `Not in the ${count(known[kind].lists)} loaded file(s), newest uploaded ${day(known[kind].latest)}` });
    } else {
      checks.push({ label, tone: "", text: "No match recorded" });
    }
  }

  const dncHit = matches.find((match) => match.match_type === "dnc");
  if (!lead.phone_e164) checks.push({ label: "DNC", tone: "", text: "No valid phone number to check" });
  else if (lead.status === "blocked_dnc") checks.push({ label: "DNC", tone: "bad", text: dncHit?.list_name ? `On the list "${dncHit.list_name}"` : (lead.status_reason ?? "On a DNC list") });
  else if (dnc.listCount === 0) checks.push({ label: "DNC", tone: "warn", text: "Not checked. No DNC list loaded" });
  else if (lead.dnc_checked_at) checks.push({ label: "DNC", tone: "ok", text: `Clear when last checked, ${when(lead.dnc_checked_at)}` });
  else checks.push({ label: "DNC", tone: "warn", text: "Not checked yet. Run a re-check on the Checks page" });
  return checks;
}

const DECISION_TEXT: Record<string, string> = { approve: "approved", reject: "rejected", needs_info: "asked for info", not_duplicate: "said it is not a duplicate" };

const Panel: FC<{ detail: Detail; session: Session; dnc: DncState; known: KnownState; back: string; prev: string; next: string }> = ({
  detail,
  session,
  dnc,
  known,
  back,
  prev,
  next,
}) => {
  const { lead, decisions, batches } = detail;
  const reviewer = can(session, "reviewer");
  const editable = PASSED.includes(lead.status);
  const shown = lead.status === "in_review" && lead.needs_info ? "needs_info" : lead.status;
  const fields: [string, string | null][] = [
    ["Owner", lead.owner_name],
    ["Phone", lead.phone_e164 ? `${phone(lead.phone_e164)}${lead.phone_raw ? ` · file said ${lead.phone_raw}` : ""}` : lead.phone_raw ? `not valid: ${lead.phone_raw}` : null],
    ["Website", lead.website],
    ["Email", lead.email],
    ["Address", [lead.address, lead.city, lead.region, lead.postal_code, lead.country].filter(Boolean).join(", ") || null],
    ["Category", lead.category],
  ];
  const reason = shown === "needs_info" ? `Needs info: ${lead.note ?? ""}` : lead.status_reason;
  return (
    <div class="card flush" id="panel" data-prev={prev} data-next={next}>
      <div class="pad" style="display:grid;gap:8px;padding-bottom:16px">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
          <div style="display:grid;min-width:0">
            <span class="muted tiny">
              Lead #{lead.id} · {lead.source}
            </span>
            <h2 style="margin:0;font-size:19px;line-height:26px;overflow-wrap:anywhere">{lead.business_name ?? "No name"}</h2>
          </div>
          <Chip value={shown} />
        </div>
        {reason ? <span class="muted small">{reason}</span> : null}
      </div>

      <div class="sec" style="border-top:none;padding-top:4px">
        <span class="eyebrow soft">Checks</span>
        {checksFor(detail, dnc, known).map((check) => (
          <div class="checkrow">
            <span class={`dot ${check.tone}`}></span>
            <span style="font-weight:600">{check.label}</span>
            <span class="muted">{check.href ? <a href={check.href}>{check.text}</a> : check.text}</span>
          </div>
        ))}
      </div>

      <div class="sec">
        {fields.map(([label, value]) => (
          <div class="frow">
            <span class="muted">{label}</span>
            <span style="overflow-wrap:anywhere">{value ?? "—"}</span>
          </div>
        ))}
        <div class="frow">
          <span class="muted">Import</span>
          <span>
            <a href={`/imports/${lead.run_id}`}>#{lead.run_id}</a> · added {when(lead.created_at)}
          </span>
        </div>
        {batches.length > 0 ? (
          <div class="frow">
            <span class="muted">Batch</span>
            <span style="display:grid;gap:4px;justify-items:start">
              {batches.map((batch) => (
                <a href={`/exports/${batch.id}`}>
                  #{batch.id} {batch.name}
                </a>
              ))}
            </span>
          </div>
        ) : null}
      </div>

      {reviewer && editable ? (
        <form method="post" action="/leads/decide" class="sec soft">
          <Csrf session={session} />
          <input type="hidden" name="lead" value={String(lead.id)} />
          <input type="hidden" name="back" value={back} />
          {/* Pressing Enter in the reason box must never count as a decision. */}
          <button type="submit" name="decision" value="" hidden tabindex={-1} aria-hidden="true"></button>
          <input id="reason" type="text" name="reason" placeholder="Reason (needed to reject or ask for info)" aria-label="Reason" />
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            {lead.status !== "approved" ? (
              <button id="d-a" class="primary" style="flex:1" type="submit" name="decision" value="approve">
                Approve
              </button>
            ) : null}
            {lead.status !== "rejected" ? (
              <button id="d-r" class="danger" type="submit" name="decision" value="reject">
                Reject
              </button>
            ) : null}
            {lead.status === "in_review" ? (
              <button id="d-n" type="submit" name="decision" value="needs_info">
                Needs info
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
      {reviewer && lead.status === "duplicate" ? (
        <form method="post" action={`/leads/${lead.id}/not-duplicate`} class="sec soft">
          <Csrf session={session} />
          <strong class="small">Not actually a duplicate?</strong>
          <input type="text" name="reason" required placeholder="Why this is a different business" aria-label="Why this is a different business" />
          <div>
            <button class="sm" type="submit">
              Send to review
            </button>
          </div>
        </form>
      ) : null}
      {!reviewer ? (
        <div class="sec muted small">You have view access. A reviewer or admin decides on leads.</div>
      ) : lead.status === "exported" ? (
        <div class="sec muted small">Exported. Its batch file has been downloaded, so it can no longer be changed here.</div>
      ) : !editable && lead.status !== "duplicate" ? (
        <div class="sec muted small">
          {lead.status === "invalid"
            ? "Held back automatically: the row is missing something a valid lead needs."
            : "Held back automatically. It returns to review if the file it matched is deleted."}
        </div>
      ) : null}

      <details class="raw">
        <summary>
          <span>Row as scraped · history</span>
          <span class="muted">Show</span>
        </summary>
        <div style="padding:0 24px 20px;display:grid;gap:14px">
          {lead.payload_json ? (
            <div class="mono" style="display:grid;gap:6px;line-height:18px">
              {Object.entries(lead.payload_json).map(([key, value]) => (
                <div style="display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px">
                  <span class="muted" style="overflow-wrap:anywhere">
                    {key}
                  </span>
                  <span style="overflow-wrap:anywhere">{value || "—"}</span>
                </div>
              ))}
            </div>
          ) : (
            <span class="muted small">The original row is no longer stored.</span>
          )}
          <div class="small" style="display:grid;gap:6px">
            <span class="eyebrow soft">History</span>
            {decisions.map((decision) => (
              <div style="display:grid;line-height:19px">
                <span>
                  <b>{decision.name}</b> {DECISION_TEXT[decision.decision] ?? decision.decision}
                  {decision.reason ? `: ${decision.reason}` : ""}
                </span>
                <span class="muted tiny">{when(decision.created_at)}</span>
              </div>
            ))}
            <div style="display:grid;line-height:19px">
              <span>
                <b>System</b> created it from import #{lead.run_id}
              </span>
              <span class="muted tiny">{when(lead.created_at)}</span>
            </div>
          </div>
        </div>
      </details>
    </div>
  );
};

const SCRIPT = `(function(){
var boxes=[].slice.call(document.querySelectorAll('input[name=lead][form=bulk]')),bar=document.getElementById('bulk'),n=document.getElementById('bulk-n'),all=document.getElementById('all');
function sync(){var k=boxes.filter(function(b){return b.checked}).length;if(bar){bar.style.display=k?'flex':'none'}if(n){n.textContent=k+' selected'}}
boxes.forEach(function(b){b.addEventListener('change',sync)});
if(all){all.addEventListener('change',function(){boxes.forEach(function(b){b.checked=all.checked});sync()})}
if(bar){bar.addEventListener('reset',function(){setTimeout(function(){if(all){all.checked=false}sync()},0)})}
sync();
var panel=document.getElementById('panel'),r=document.getElementById('reason');
document.addEventListener('keydown',function(e){
if(e.metaKey||e.ctrlKey||e.altKey||/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName))return;
var k=e.key.toLowerCase();
if(k==='j'||k==='k'){var go=panel&&panel.getAttribute(k==='j'?'data-next':'data-prev');if(!go)return;location.href=go}
else if(k==='a'||k==='r'||k==='n'){var b=document.getElementById('d-'+k);if(!b)return;
if(k!=='a'&&r&&!r.value.trim()){r.setAttribute('data-go',k);r.placeholder=(k==='r'?'Why are you rejecting it?':'What information is missing?')+' Then press Enter';r.focus()}else{b.click()}}
else return;
e.preventDefault()});
if(r){r.addEventListener('keydown',function(e){if(e.key!=='Enter')return;e.preventDefault();var b=document.getElementById('d-'+(r.getAttribute('data-go')||''));if(b&&r.value.trim()){b.click()}})}
})();`;

export function registerLeadRoutes(app: App, { db }: Deps): void {
  app.get("/leads", async (c) => {
    const session = c.get("session");
    const status = STATUSES.includes(c.req.query("status") ?? "") ? c.req.query("status")! : "";
    const run = Number(c.req.query("run")) || 0;
    const q = (c.req.query("q") ?? "").trim();
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const asked = c.req.query("tab") ?? "";
    const tab: Tab = status ? "all" : TABS.some(([key]) => key === asked) ? (asked as Tab) : q || run ? "all" : "in_review";
    const wanted = Number(c.req.query("lead")) || 0;

    const base: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      base.push(`l.status = $${params.length}`);
    }
    if (run) {
      params.push(run);
      base.push(`l.run_id = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
      const n = params.length;
      base.push(
        `(l.business_name ILIKE $${n} OR l.phone_e164 ILIKE $${n} OR l.phone_raw ILIKE $${n} OR l.website_domain ILIKE $${n} OR l.city ILIKE $${n} OR l.category ILIKE $${n} OR l.email ILIKE $${n})`,
      );
    }
    const baseClause = base.length ? base.join(" AND ") : "TRUE";

    const counts = (await one<Record<Tab, number>>(
      db,
      `SELECT ${TABS.map(([key]) => `(count(*) FILTER (WHERE ${TAB_WHERE[key]}))::int AS ${key === "all" ? '"all"' : key}`).join(", ")}
       FROM leads l WHERE ${baseClause}`,
      params,
    ))!;
    const total = counts[tab] ?? 0;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const current = Math.min(page, pages);
    const leads = await many<LeadRow>(
      db,
      `SELECT l.*, s.name AS source, ${NEEDS_INFO} AS needs_info, NULL AS note
       FROM leads l JOIN runs r ON r.id = l.run_id JOIN sources s ON s.id = r.source_id
       WHERE ${baseClause} AND ${TAB_WHERE[tab]} ORDER BY l.id LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`,
      params,
    );

    const href = (change: { tab?: Tab; status?: string; run?: number; q?: string; page?: number; lead?: number | null }) => {
      const next = { tab, status, run, q, page: current, lead: null as number | null, ...change };
      const search = new URLSearchParams();
      if (next.status) search.set("status", next.status);
      else if (next.tab !== "in_review" || next.q || next.run) search.set("tab", next.tab);
      if (next.run) search.set("run", String(next.run));
      if (next.q) search.set("q", next.q);
      if (next.page > 1) search.set("page", String(next.page));
      if (next.lead) search.set("lead", String(next.lead));
      const text = search.toString();
      return text ? `/leads?${text}` : "/leads";
    };

    const selectedId = wanted || leads[0]?.id || 0;
    const detail = selectedId ? await loadDetail(db, selectedId) : null;
    const dnc = await getDncState(db);
    const known = await getKnownState(db);
    const reviewer = can(session, "reviewer");
    const at = leads.findIndex((lead) => lead.id === selectedId);
    const before = at > 0 ? leads[at - 1] : undefined;
    const after = at === -1 ? leads[0] : leads[at + 1];
    // Where a decision lands: on the next lead when the decided one leaves this list, otherwise on the same lead.
    const leaves = tab !== "all";
    const back = leaves ? href({ lead: (after ?? before)?.id ?? null }) : href({ lead: selectedId || null });
    const filtered = Boolean(status || run || q);

    return render(
      c,
      <Page
        c={c}
        title="Review"
        active="review"
        step="Step 4"
        sub="Leads that passed the automatic checks. Approve, reject, or ask for more info."
        aside={
          reviewer ? (
            <span class="muted tiny">
              Shortcuts: <b style="color:var(--ink)">A</b> approve · <b style="color:var(--ink)">R</b> reject · <b style="color:var(--ink)">N</b> needs info ·{" "}
              <b style="color:var(--ink)">J / K</b> next / previous
            </span>
          ) : null
        }
      >
        {dnc.listCount === 0 ? (
          <div class="note warn">
            <b>No DNC list is loaded</b>, so none of these leads has been checked against one. <a href="/checks">Load a list</a>
          </div>
        ) : null}
        {filtered ? (
          <div class="small" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <span class="muted">Showing only:</span>
            {q ? <Chip value="q" tone="primary" label={`Search "${q}" ×`} href={href({ q: "", page: 1 })} /> : null}
            {run ? <Chip value="run" tone="primary" label={`Import #${run} ×`} href={href({ run: 0, page: 1 })} /> : null}
            {status ? <Chip value="status" tone="primary" label={`${statusLabel(status)} ×`} href={href({ status: "", tab: "all", page: 1 })} /> : null}
          </div>
        ) : null}

        {status ? null : (
          <div class="tabs">
            {TABS.map(([key, label]) => (
              <a href={href({ tab: key, page: 1 })} class={key === tab ? "on" : ""}>
                {label}
                <span>{count(counts[key] ?? 0)}</span>
              </a>
            ))}
          </div>
        )}

        <div class="split">
          <div class="card flush list">
            {reviewer ? (
              <form id="bulk" class="bulk" method="post" action="/leads/decide">
                <Csrf session={session} />
                <input type="hidden" name="back" value={href({})} />
                <button type="submit" name="decision" value="" hidden tabindex={-1} aria-hidden="true"></button>
                <b id="bulk-n">Selected</b>
                <input type="text" name="reason" placeholder="Reason (to reject or ask for info)" aria-label="Reason for the selected leads" style="flex:1;min-width:180px;height:32px" />
                <button class="primary sm" type="submit" name="decision" value="approve">
                  Approve
                </button>
                <button class="danger sm" type="submit" name="decision" value="reject">
                  Reject
                </button>
                <button class="sm" type="submit" name="decision" value="needs_info">
                  Needs info
                </button>
                <button class="link" type="reset" style="color:var(--primary-700)">
                  Clear
                </button>
              </form>
            ) : null}
            <noscript>
              <style dangerouslySetInnerHTML={{ __html: ".bulk{display:flex!important}" }} />
            </noscript>
            <div class="lhead">
              <span>{reviewer && leads.length > 0 ? <input type="checkbox" id="all" aria-label="Select all on this page" /> : null}</span>
              <span class="lcols">
                <span>Business</span>
                <span>Phone</span>
                <span>Status</span>
              </span>
            </div>
            {leads.map((lead) => (
              <div class={`lrow${lead.id === selectedId ? " on" : ""}`}>
                <span>
                  {reviewer ? <input type="checkbox" name="lead" form="bulk" value={String(lead.id)} aria-label={`Select lead ${lead.id}`} /> : null}
                </span>
                <a class="lcols" href={href({ lead: lead.id })}>
                  <span style="display:grid;min-width:0;line-height:18px">
                    <span class="clip" style="font-weight:600">
                      {lead.business_name ?? "No name"}
                    </span>
                    <span class="muted tiny clip">
                      {[lead.category, [lead.city, lead.region].filter(Boolean).join(", "), lead.website_domain].filter(Boolean).join(" · ") || `Lead #${lead.id}`}
                    </span>
                  </span>
                  <span class="mono clip">{lead.phone_e164 ? phone(lead.phone_e164) : <span class="muted">no valid phone</span>}</span>
                  <span>
                    <Chip value={lead.status === "in_review" && lead.needs_info ? "needs_info" : lead.status} />
                  </span>
                </a>
              </div>
            ))}
            {leads.length === 0 ? (
              <div class="empty" style="padding:48px 24px;display:grid;gap:6px">
                <strong style="color:var(--ink)">{tab === "in_review" && !filtered ? "Nothing is waiting for review" : "No leads match"}</strong>
                <span class="small">
                  {tab === "in_review" && !filtered ? "New leads land here after an import." : "Try another tab or clear the search."}
                </span>
              </div>
            ) : null}
            <Pager page={current} pages={pages} total={total} shown={leads.length} href={(target) => href({ page: target })} noun="leads" size={PAGE_SIZE} />
          </div>

          <div class="panel">
            {detail ? (
              <Panel
                detail={detail}
                session={session}
                dnc={dnc}
                known={known}
                back={back}
                prev={before ? href({ lead: before.id }) : ""}
                next={after ? href({ lead: after.id }) : ""}
              />
            ) : wanted ? (
              <div class="card muted">Lead #{wanted} does not exist. Its import may have been deleted.</div>
            ) : null}
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
      </Page>,
    );
  });

  app.post("/leads/decide", async (c) => {
    const session = need(c, "reviewer");
    const form = c.get("form");
    const decision = str(form, "decision") as Decision;
    if (!["approve", "reject", "needs_info"].includes(decision)) throw new ReviewError("Choose approve, reject or needs info.");
    const leadIds = list(form, "lead").map(Number).filter((id) => Number.isInteger(id));
    const result = await decideLeads(db, { user: session.user, leadIds, decision, reason: str(form, "reason") || null });
    const verb = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "marked as needing info";
    const skipped = result.skipped > 0 ? ` ${count(result.skipped)} skipped because their current status does not allow it.` : "";
    const back = str(form, "back");
    const target = back === "/leads" || back.startsWith("/leads?") ? back : refererPath(c, "/leads");
    return ok(c, target, `${count(result.changed)} lead(s) ${verb}.${skipped}`);
  });

  // One lead is shown in the side panel of the Review screen, whatever tab it belongs to.
  app.get("/leads/:id", (c) => c.redirect(`/leads?tab=all&lead=${idParam(c)}`, 303));

  app.post("/leads/:id/not-duplicate", async (c) => {
    const session = need(c, "reviewer");
    const leadId = idParam(c);
    const status = await markNotDuplicate(db, { user: session.user, leadId, reason: str(c.get("form"), "reason") });
    return ok(
      c,
      refererPath(c, `/leads?tab=all&lead=${leadId}`),
      status === "in_review" ? "Sent to the review queue." : "Not a duplicate, but its number is on a DNC list, so it is blocked.",
    );
  });
}

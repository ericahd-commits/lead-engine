import { HTTPException } from "hono/http-exception";
import { many, one } from "../../db/db.js";
import { getDncState } from "../../pipeline/dnc.js";
import { decideLeads, markNotDuplicate, ReviewError, type Decision } from "../../reviews.js";
import { can, idParam, list, need, ok, refererPath, str, type App, type Deps } from "../http.js";
import { Chip, count, Csrf, Page, Pager, render, when } from "../views.js";

const STATUSES = ["in_review", "approved", "rejected", "exported", "duplicate", "blocked_dnc", "invalid"];
const PAGE_SIZE = 50;

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
  last_note: string | null;
};

export function registerLeadRoutes(app: App, { db }: Deps): void {
  app.get("/leads", async (c) => {
    const session = c.get("session");
    const status = STATUSES.includes(c.req.query("status") ?? "") ? c.req.query("status")! : "";
    const run = Number(c.req.query("run")) || 0;
    const q = (c.req.query("q") ?? "").trim();
    const page = Math.max(1, Number(c.req.query("page")) || 1);

    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      where.push(`l.status = $${params.length}`);
    }
    if (run) {
      params.push(run);
      where.push(`l.run_id = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
      const n = params.length;
      where.push(
        `(l.business_name ILIKE $${n} OR l.phone_e164 ILIKE $${n} OR l.website_domain ILIKE $${n} OR l.city ILIKE $${n} OR l.category ILIKE $${n} OR l.email ILIKE $${n})`,
      );
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const total = (await one<{ count: number }>(db, `SELECT count(*)::int AS count FROM leads l ${clause}`, params))?.count ?? 0;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const leads = await many<LeadRow>(
      db,
      `SELECT l.*, s.name AS source,
              (SELECT d.decision || ': ' || coalesce(d.reason, '') FROM audit_decisions d
               WHERE d.lead_id = l.id AND d.decision = 'needs_info' ORDER BY d.id DESC LIMIT 1) AS last_note
       FROM leads l JOIN runs r ON r.id = l.run_id JOIN sources s ON s.id = r.source_id
       ${clause} ORDER BY l.id LIMIT ${PAGE_SIZE} OFFSET ${(Math.min(page, pages) - 1) * PAGE_SIZE}`,
      params,
    );
    const dnc = await getDncState(db);
    const reviewQueue = status === "in_review";
    const href = (target: number) => {
      const search = new URLSearchParams();
      if (status) search.set("status", status);
      if (run) search.set("run", String(run));
      if (q) search.set("q", q);
      if (target > 1) search.set("page", String(target));
      const text = search.toString();
      return text ? `/leads?${text}` : "/leads";
    };
    const canDecide = can(session, "reviewer") && ["in_review", "approved", "rejected", ""].includes(status);

    return render(
      c,
      <Page
        c={c}
        title={reviewQueue ? "Review queue" : "Leads"}
        active={reviewQueue ? "review" : "leads"}
        sub={reviewQueue ? "Leads that passed the automatic checks and need a person to approve or reject them." : "Every lead the app holds, in any state."}
      >
        {dnc.listCount === 0 ? (
          <div class="note warn">
            <b>No DNC list is loaded</b>, so none of these leads has been checked against one. <a href="/dnc">Upload a list</a>
          </div>
        ) : null}
        <form method="get" action="/leads" class="card">
          <div class="row">
            <div>
              <label for="q">Search</label>
              <input id="q" type="search" name="q" value={q} placeholder="Name, phone, website, city, category, email" />
            </div>
            <div>
              <label for="status">Status</label>
              <select id="status" name="status">
                <option value="">Any status</option>
                {STATUSES.map((value) => (
                  <option value={value} selected={value === status}>
                    {value.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            {run ? <input type="hidden" name="run" value={String(run)} /> : null}
            <div class="fit">
              <button type="submit">Filter</button>
            </div>
          </div>
          {run ? (
            <p class="small muted" style="margin-bottom:0">
              Showing import <a href={`/imports/${run}`}>#{run}</a> only. <a href={status ? `/leads?status=${status}` : "/leads"}>Show all imports</a>
            </p>
          ) : null}
        </form>

        <form method="post" action="/leads/decide" class="card">
          <Csrf session={session} />
          {leads.length === 0 ? (
            <p class="muted">{reviewQueue && !q && !run ? "Nothing is waiting for review." : "No leads match."}</p>
          ) : (
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    {canDecide ? (
                      <th>
                        <input type="checkbox" id="all" aria-label="Select all on this page" />
                      </th>
                    ) : null}
                    <th>Lead</th>
                    <th>Business</th>
                    <th>Phone</th>
                    <th>Website</th>
                    <th>City</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => (
                    <tr>
                      {canDecide ? (
                        <td>
                          <input type="checkbox" name="lead" value={String(lead.id)} aria-label={`Select lead ${lead.id}`} />
                        </td>
                      ) : null}
                      <td>
                        <a href={`/leads/${lead.id}`}>#{lead.id}</a>
                      </td>
                      <td>
                        {lead.business_name ?? <span class="muted">no name</span>}
                        {lead.owner_name ? <div class="small muted">{lead.owner_name}</div> : null}
                      </td>
                      <td class="mono">{lead.phone_e164 ?? <span class="muted">{lead.phone_raw ?? ""}</span>}</td>
                      <td>{lead.website_domain}</td>
                      <td>{[lead.city, lead.region].filter(Boolean).join(", ")}</td>
                      <td>{lead.category}</td>
                      <td>
                        <Chip value={lead.status} />
                        {lead.status_reason ? <div class="small muted">{lead.status_reason}</div> : null}
                        {lead.status === "in_review" && lead.last_note ? <div class="small muted">{lead.last_note.replace("needs_info", "Needs info")}</div> : null}
                      </td>
                      <td class="small">{lead.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={Math.min(page, pages)} pages={pages} total={total} href={href} noun="leads" />
          {canDecide && leads.length > 0 ? (
            <div class="row" style="margin-top:14px">
              <div>
                <label for="reason">Reason (needed to reject or to ask for info)</label>
                <input id="reason" type="text" name="reason" />
              </div>
              <div class="fit">
                <button class="good" type="submit" name="decision" value="approve">
                  Approve selected
                </button>{" "}
                <button class="danger" type="submit" name="decision" value="reject">
                  Reject selected
                </button>{" "}
                <button type="submit" name="decision" value="needs_info">
                  Needs info
                </button>
              </div>
            </div>
          ) : null}
        </form>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "var a=document.getElementById('all');if(a){a.addEventListener('change',function(){document.querySelectorAll('input[name=lead]').forEach(function(b){b.checked=a.checked})})}",
          }}
        />
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
    return ok(c, refererPath(c, "/leads"), `${count(result.changed)} lead(s) ${verb}.${skipped}`);
  });

  app.get("/leads/:id", async (c) => {
    const session = c.get("session");
    const leadId = idParam(c);
    const lead = await one<LeadRow & { payload_json: Record<string, string> | null }>(
      db,
      `SELECT l.*, s.name AS source, w.payload_json, NULL AS last_note
       FROM leads l JOIN runs r ON r.id = l.run_id JOIN sources s ON s.id = r.source_id
       LEFT JOIN raw_records w ON w.id = l.source_record_id WHERE l.id = $1`,
      [leadId],
    );
    if (!lead) throw new HTTPException(404, { message: "That lead does not exist (its import may have been deleted)." });
    const matches = await many<{ match_type: string; matched_ref: string; matched_lead_id: number | null; rule_used: string; checked_at: Date; other_name: string | null; other_status: string | null; list_name: string | null }>(
      db,
      `SELECT m.match_type, m.matched_ref, m.matched_lead_id, m.rule_used, m.checked_at,
              o.business_name AS other_name, o.status AS other_status,
              (SELECT d.name FROM dnc_lists d WHERE 'dnc_list:' || d.id = m.matched_ref) AS list_name
       FROM dedupe_matches m LEFT JOIN leads o ON o.id = m.matched_lead_id WHERE m.lead_id = $1 ORDER BY m.id`,
      [leadId],
    );
    const decisions = await many<{ decision: string; reason: string | null; created_at: Date; name: string }>(
      db,
      `SELECT d.decision, d.reason, d.created_at, u.name FROM audit_decisions d
       JOIN users u ON u.id = d.reviewer_user_id WHERE d.lead_id = $1 ORDER BY d.id DESC`,
      [leadId],
    );
    const batches = await many<{ id: number; name: string; status: string }>(
      db,
      `SELECT e.id, e.name, e.status FROM export_batch_leads b JOIN export_batches e ON e.id = b.batch_id WHERE b.lead_id = $1`,
      [leadId],
    );
    const dnc = await getDncState(db);
    const reviewer = can(session, "reviewer");
    const fields: [string, string | null][] = [
      ["Business name", lead.business_name],
      ["Phone", lead.phone_e164 ? `${lead.phone_e164}${lead.phone_raw ? ` (file said: ${lead.phone_raw})` : ""}` : lead.phone_raw ? `not valid: ${lead.phone_raw}` : null],
      ["Website", lead.website],
      ["Email", lead.email],
      ["Owner name", lead.owner_name],
      ["Address", [lead.address, lead.city, lead.region, lead.postal_code, lead.country].filter(Boolean).join(", ") || null],
      ["Category", lead.category],
      ["Source", lead.source],
    ];

    return render(
      c,
      <Page c={c} title={lead.business_name ?? `Lead #${lead.id}`} active="leads" sub={`Lead #${lead.id} · added ${when(lead.created_at)}`}>
        <div class="card">
          <p>
            <Chip value={lead.status} /> {lead.status_reason ? <span class="muted">{lead.status_reason}</span> : null}
          </p>
          <dl class="kv">
            {fields.map(([label, value]) => (
              <>
                <dt>{label}</dt>
                <dd>{value ?? <span class="muted">—</span>}</dd>
              </>
            ))}
            <dt>DNC check</dt>
            <dd>
              {!lead.phone_e164
                ? "No valid phone number to check"
                : lead.dnc_checked_at
                  ? `Last checked ${when(lead.dnc_checked_at)} against the lists loaded then`
                  : dnc.listCount === 0
                    ? "Not checked. No DNC list is loaded."
                    : "Not checked yet. Run a re-check on the DNC page."}
            </dd>
            <dt>Import</dt>
            <dd>
              <a href={`/imports/${lead.run_id}`}>#{lead.run_id}</a>
            </dd>
            {batches.length > 0 ? (
              <>
                <dt>Export batch</dt>
                <dd>
                  {batches.map((batch) => (
                    <div>
                      <a href={`/exports/${batch.id}`}>{batch.name}</a> <Chip value={batch.status} />
                    </div>
                  ))}
                </dd>
              </>
            ) : null}
          </dl>
        </div>

        {reviewer && ["in_review", "approved", "rejected"].includes(lead.status) ? (
          <form method="post" action="/leads/decide" class="card">
            <Csrf session={session} />
            <input type="hidden" name="lead" value={String(lead.id)} />
            <h2>Decision</h2>
            <div class="row">
              <div>
                <label for="reason">Reason (needed to reject or to ask for info)</label>
                <input id="reason" type="text" name="reason" />
              </div>
              <div class="fit">
                {lead.status !== "approved" ? (
                  <button class="good" type="submit" name="decision" value="approve">
                    Approve
                  </button>
                ) : null}{" "}
                {lead.status !== "rejected" ? (
                  <button class="danger" type="submit" name="decision" value="reject">
                    Reject
                  </button>
                ) : null}{" "}
                {lead.status === "in_review" ? (
                  <button type="submit" name="decision" value="needs_info">
                    Needs info
                  </button>
                ) : null}
              </div>
            </div>
          </form>
        ) : null}

        {reviewer && lead.status === "duplicate" ? (
          <form method="post" action={`/leads/${lead.id}/not-duplicate`} class="card">
            <Csrf session={session} />
            <h2>Not actually a duplicate?</h2>
            <div class="row">
              <div>
                <label for="why">Why this is a different business</label>
                <input id="why" type="text" name="reason" required />
              </div>
              <div class="fit">
                <button type="submit">Send to review</button>
              </div>
            </div>
          </form>
        ) : null}

        {matches.length > 0 ? (
          <div class="card">
            <h2>Matches found</h2>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Matched on</th>
                  <th>Matched with</th>
                  <th>Checked</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((match) => (
                  <tr>
                    <td>{match.match_type === "dnc" ? "DNC list" : "Duplicate"}</td>
                    <td>{match.rule_used.replace("name_city", "name and city").replace("domain", "website")}</td>
                    <td>
                      {match.match_type === "dnc" ? (
                        (match.list_name ?? "a list that has since been deleted")
                      ) : match.matched_lead_id ? (
                        <>
                          <a href={`/leads/${match.matched_lead_id}`}>
                            #{match.matched_lead_id} {match.other_name}
                          </a>{" "}
                          {match.other_status ? <Chip value={match.other_status} /> : null}
                        </>
                      ) : (
                        match.matched_ref
                      )}
                    </td>
                    <td>{when(match.checked_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {decisions.length > 0 ? (
          <div class="card">
            <h2>Review history</h2>
            <table>
              <tbody>
                {decisions.map((decision) => (
                  <tr>
                    <td>{when(decision.created_at)}</td>
                    <td>{decision.name}</td>
                    <td>{decision.decision.replace(/_/g, " ")}</td>
                    <td>{decision.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div class="card">
          <h2>Row as scraped</h2>
          {lead.payload_json ? (
            <dl class="kv small">
              {Object.entries(lead.payload_json).map(([key, value]) => (
                <>
                  <dt>{key}</dt>
                  <dd>{value || <span class="muted">—</span>}</dd>
                </>
              ))}
            </dl>
          ) : (
            <p class="muted">The original row is no longer stored.</p>
          )}
        </div>
      </Page>,
    );
  });

  app.post("/leads/:id/not-duplicate", async (c) => {
    const session = need(c, "reviewer");
    const leadId = idParam(c);
    const status = await markNotDuplicate(db, { user: session.user, leadId, reason: str(c.get("form"), "reason") });
    return ok(
      c,
      `/leads/${leadId}`,
      status === "in_review" ? "Sent to the review queue." : "Not a duplicate, but its number is on a DNC list, so it is blocked.",
    );
  });
}

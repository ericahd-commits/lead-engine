import { ApprovalError, requestApproval } from "../../approvals.js";
import { many, one } from "../../db/db.js";
import { checkBatch, createBatch, ExportError, downloadBatch, getBatch, getBatchLeads, removeLeadsFromBatch } from "../../exports.js";
import { can, idParam, list, need, ok, str, withMessage, type App, type Deps } from "../http.js";
import { Chip, count, Csrf, Page, render, when } from "../views.js";

export function registerExportRoutes(app: App, { db, config }: Deps): void {
  app.get("/exports", async (c) => {
    const session = c.get("session");
    const batches = await many<{ id: number; name: string; target_ref: string | null; status: string; created_at: Date; creator: string; leads: number }>(
      db,
      `SELECT e.id, e.name, e.target_ref, e.status, e.created_at, u.name AS creator,
              (SELECT count(*)::int FROM export_batch_leads b WHERE b.batch_id = e.id) AS leads
       FROM export_batches e JOIN users u ON u.id = e.created_by ORDER BY e.id DESC LIMIT 200`,
    );
    const waiting = await one<{ count: number }>(
      db,
      `SELECT count(*)::int AS count FROM leads l WHERE l.status = 'approved' AND NOT EXISTS (
         SELECT 1 FROM export_batch_leads b JOIN export_batches e ON e.id = b.batch_id WHERE b.lead_id = l.id AND e.status <> 'failed')`,
    );

    const stepOf = (status: string) => (status === "done" ? 3 : status === "approved" || status === "running" ? 2 : 1);
    const stepClass = (at: number, n: number) => (n <= at ? "done" : n === at + 1 ? "now" : "");

    return render(
      c,
      <Page
        c={c}
        title="Export"
        active="exports"
        step="Step 4"
        sub="Approved leads leave the app in batches, as a CSV file. Each batch needs an admin's approval before its file can be downloaded."
      >
        {can(session, "reviewer") ? (
          (waiting?.count ?? 0) === 0 ? (
            <div class="card muted">No approved leads are waiting to be exported.</div>
          ) : (
            <form method="post" action="/exports" class="card flush">
              <Csrf session={session} />
              <div class="pad" style="display:grid;gap:14px">
                <div style="display:grid;gap:2px">
                  <h2 style="margin:0">New batch</h2>
                  <span class="muted small">
                    {count(waiting!.count)} approved lead(s) are not in a batch yet. A new batch takes all of them.
                  </span>
                </div>
                <div class="row">
                  <label>
                    Batch name
                    <input id="name" type="text" name="name" required placeholder="e.g. Gyms Ohio, week 48" />
                  </label>
                  <label>
                    Where it is going (note for the approver)
                    <input id="target" type="text" name="target_ref" placeholder="e.g. VICIdial list 1048, or Close" />
                  </label>
                </div>
              </div>
              <div class="card-f">
                <span class="fill muted small">Nothing is sent to VICIdial or Close by this app. The file is downloaded by a person after approval.</span>
                <button class="primary lift" type="submit">
                  Create and request approval
                </button>
              </div>
            </form>
          )
        ) : null}
        {batches.length === 0 ? <div class="card muted">No batches yet.</div> : null}
        {batches.map((batch) => {
          const at = stepOf(batch.status);
          return (
            <div class="card" style="display:grid;gap:14px">
              <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
                <div style="display:grid;gap:2px;min-width:0">
                  <a href={`/exports/${batch.id}`} style="font-weight:700;font-size:16px;color:var(--ink);overflow-wrap:anywhere">
                    #{batch.id} {batch.name}
                  </a>
                  <span class="muted small">
                    {count(batch.leads)} lead(s) · {batch.target_ref ? `going to ${batch.target_ref}` : "destination not stated"} · created{" "}
                    {when(batch.created_at)} by {batch.creator}
                  </span>
                </div>
                <Chip value={batch.status} />
              </div>
              <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
                <div class="steps">
                  <span class={stepClass(at, 1)}>{batch.status === "draft" ? "Created, approval not requested" : "Created"}</span>
                  <i></i>
                  <span class={stepClass(at, 2)}>Approved</span>
                  <i></i>
                  <span class={stepClass(at, 3)}>Downloaded</span>
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                  <a class="btn sm" href={`/exports/${batch.id}`}>
                    Open
                  </a>
                  {can(session, "reviewer") && (batch.status === "approved" || batch.status === "done") ? (
                    <form method="post" action={`/exports/${batch.id}/download`} class="inline">
                      <Csrf session={session} />
                      <button class="primary sm" type="submit">
                        {batch.status === "done" ? "Download again" : "Download CSV"}
                      </button>
                    </form>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </Page>,
    );
  });

  app.post("/exports", async (c) => {
    const session = need(c, "reviewer");
    const form = c.get("form");
    const { batchId, leadCount } = await createBatch(db, {
      user: session.user,
      name: str(form, "name"),
      targetRef: str(form, "target_ref") || null,
      runId: null,
    });
    try {
      await requestApproval(db, { user: session.user, subjectType: "export_batch", subjectId: batchId, note: "" });
    } catch (error) {
      if (!(error instanceof ApprovalError) && !(error instanceof ExportError)) throw error;
      // The batch exists; say plainly that approval was not requested and why.
      return c.redirect(
        withMessage(`/exports/${batchId}`, "err", `Batch created with ${count(leadCount)} lead(s), but approval was not requested: ${error.message}`),
        303,
      );
    }
    return ok(c, "/exports", `Batch created with ${count(leadCount)} lead(s) and approval requested. An admin has to approve before the file can be downloaded.`);
  });

  app.get("/exports/:id", async (c) => {
    const session = c.get("session");
    const batchId = idParam(c);
    const batch = await getBatch(db, batchId);
    const leads = await getBatchLeads(db, batchId);
    const check = await checkBatch(db, batchId);
    const people = await one<{ requester: string | null; approver: string | null }>(
      db,
      `SELECT (SELECT name FROM users WHERE id = $1) AS requester, (SELECT name FROM users WHERE id = $2) AS approver`,
      [batch.requested_by, batch.approved_by],
    );
    const reviewer = can(session, "reviewer");
    const editable = reviewer && batch.status !== "done" && batch.status !== "running";
    const bad = new Map(check.ineligible.map((item) => [item.leadId, item.reason]));
    const shown = leads.slice(0, 500);
    const neverChecked = leads.filter((lead) => lead.phone_e164 && !lead.dnc_checked_at).length;

    return render(
      c,
      <Page c={c} title={`Batch #${batch.id}: ${batch.name}`} active="exports" step="Step 4" crumb={`Export / #${batch.id}`} sub={`${count(leads.length)} lead(s) · created ${when(batch.created_at)}`}>
        <div class="card">
          <dl class="kv">
            <dt>Status</dt>
            <dd>
              <Chip value={batch.status} />
            </dd>
            <dt>Output</dt>
            <dd>CSV file download. Nothing is sent to Close or VICIdial by this app.</dd>
            <dt>Going to</dt>
            <dd>{batch.target_ref ?? <span class="muted">not stated</span>}</dd>
            <dt>Approval</dt>
            <dd>
              {batch.status === "draft"
                ? "Not requested"
                : batch.status === "awaiting_approval"
                  ? `Requested by ${people?.requester ?? "someone"}, waiting for an admin`
                  : `Approved by ${people?.approver ?? "an admin"} on ${when(batch.approved_at)}`}
            </dd>
            <dt>DNC scrub</dt>
            <dd>
              {check.dncNeverLoaded
                ? "NOT DONE. No DNC list is loaded."
                : batch.status === "done"
                  ? `Checked against ${count(Number(batch.result_json?.dncListsAtExport ?? 0))} list(s) when the file was first downloaded`
                  : `Checked just now against ${count(check.dncLists)} list(s)`}
            </dd>
          </dl>
        </div>

        {check.dncNeverLoaded && batch.status !== "done" ? (
          <div class="note warn">
            <b>This batch has not been scrubbed against any do-not-call list</b>
            {neverChecked > 0 ? ` (${count(neverChecked)} lead(s) with a phone number)` : ""}. <a href="/checks">Upload a DNC list</a>{" "}
            first unless that scrub is being done somewhere else.
          </div>
        ) : null}

        {check.ineligible.length > 0 ? (
          <div class="note err">
            <b>{count(check.ineligible.length)} lead(s) in this batch can no longer be exported.</b> The file cannot be
            downloaded until they are removed, and removing them means approval has to be asked for again.
            {editable ? (
              <form method="post" action={`/exports/${batch.id}/remove-ineligible`} style="margin-top:10px">
                <Csrf session={session} />
                <button class="danger" type="submit">
                  Remove these {count(check.ineligible.length)} lead(s)
                </button>
              </form>
            ) : null}
          </div>
        ) : null}

        {reviewer ? (
          <div class="card">
            {batch.status === "draft" ? (
              <form method="post" action={`/exports/${batch.id}/request-approval`}>
                <Csrf session={session} />
                <div class="row">
                  <div>
                    <label for="note">Note for the approver</label>
                    <input id="note" type="text" name="note" />
                  </div>
                  <div class="fit">
                    <button class="primary" type="submit" disabled={check.ineligible.length > 0 || leads.length === 0}>
                      Ask for approval
                    </button>
                  </div>
                </div>
              </form>
            ) : batch.status === "awaiting_approval" ? (
              <p style="margin:0">
                Waiting for an admin to decide. <a href="/approvals">Open approvals</a>
              </p>
            ) : (
              <form method="post" action={`/exports/${batch.id}/download`}>
                <Csrf session={session} />
                <button class="primary" type="submit" disabled={check.ineligible.length > 0}>
                  {batch.status === "done" ? "Download the file again" : "Download CSV"}
                </button>
                <span class="muted small">
                  {" "}
                  {batch.status === "done"
                    ? `First downloaded ${when(String(batch.result_json?.exportedAt ?? ""))} by ${String(batch.result_json?.exportedBy ?? "")}.`
                    : "The first download marks every lead in the batch as exported."}
                </span>
              </form>
            )}
          </div>
        ) : null}

        <form method="post" action={`/exports/${batch.id}/remove`} class="card">
          <Csrf session={session} />
          <h2>Leads in this batch</h2>
          {leads.length > shown.length ? <p class="muted small">Showing the first {count(shown.length)}. The file holds all {count(leads.length)}.</p> : null}
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  {editable ? <th></th> : null}
                  <th>Lead</th>
                  <th>Business</th>
                  <th>Phone</th>
                  <th>City</th>
                  <th>Source</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((lead) => (
                  <tr>
                    {editable ? (
                      <td>
                        <input type="checkbox" name="lead" value={String(lead.id)} aria-label={`Select lead ${lead.id}`} />
                      </td>
                    ) : null}
                    <td>
                      <a href={`/leads/${lead.id}`}>#{lead.id}</a>
                    </td>
                    <td>{lead.business_name}</td>
                    <td class="mono">{lead.phone_e164}</td>
                    <td>{[lead.city, lead.region].filter(Boolean).join(", ")}</td>
                    <td class="small">{lead.source_name}</td>
                    <td>{bad.has(lead.id) ? <span style="color:var(--bad)">{bad.get(lead.id)}</span> : <Chip value={lead.status} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {editable && leads.length > 0 ? (
            <p style="margin-bottom:0">
              <button class="danger" type="submit">
                Remove selected from batch
              </button>{" "}
              <span class="muted small">Removed leads stay approved and can go into a later batch. Any approval is reset.</span>
            </p>
          ) : null}
        </form>
      </Page>,
    );
  });

  app.post("/exports/:id/remove", async (c) => {
    const session = need(c, "reviewer");
    const batchId = idParam(c);
    const leadIds = list(c.get("form"), "lead").map(Number).filter((id) => Number.isInteger(id));
    const removed = await removeLeadsFromBatch(db, { user: session.user, batchId, leadIds });
    return ok(c, `/exports/${batchId}`, removed > 0 ? `${count(removed)} lead(s) removed. The batch is a draft again.` : "No leads were selected.");
  });

  app.post("/exports/:id/remove-ineligible", async (c) => {
    const session = need(c, "reviewer");
    const batchId = idParam(c);
    const removed = await removeLeadsFromBatch(db, { user: session.user, batchId, leadIds: "ineligible" });
    return ok(c, `/exports/${batchId}`, `${count(removed)} lead(s) removed. The batch is a draft again and needs approval.`);
  });

  app.post("/exports/:id/request-approval", async (c) => {
    const session = need(c, "reviewer");
    const batchId = idParam(c);
    await requestApproval(db, { user: session.user, subjectType: "export_batch", subjectId: batchId, note: str(c.get("form"), "note") });
    return ok(c, `/exports/${batchId}`, "Approval requested. An admin has to approve before the file can be downloaded.");
  });

  app.post("/exports/:id/download", async (c) => {
    const session = need(c, "reviewer");
    const { fileName, csv } = await downloadBatch(db, config, { user: session.user, batchId: idParam(c) });
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${fileName}"`);
    c.header("Cache-Control", "no-store");
    // Plain UTF-8 with no byte-order mark: list loaders can trip over one in the first header.
    return c.body(csv);
  });
}

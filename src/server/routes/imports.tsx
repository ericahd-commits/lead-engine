import { HTTPException } from "hono/http-exception";
import { requestApproval } from "../../approvals.js";
import { many, one } from "../../db/db.js";
import { describeRunDelete } from "../../deletes.js";
import { createImport, getSuggestedMapping, ImportError, processImport, type RunSummary } from "../../pipeline/importRun.js";
import { getKnownState } from "../../pipeline/known.js";
import { FIELD_LABELS, LEAD_FIELDS } from "../../pipeline/mapping.js";
import { loadSettings } from "../../settings.js";
import { can, file, idParam, need, ok, readUpload, str, type App, type Ctx, type Deps } from "../http.js";
import { Chip, count, Csrf, Page, render, when } from "../views.js";

type RunRow = {
  id: number;
  source: string;
  file_name: string | null;
  status: string;
  row_count: number;
  summary_json: RunSummary | null;
  error: string | null;
  created_at: Date;
  uploader: string | null;
};

// Settings name the stored columns; the matching form names the lead fields.
const REQUIRED_AS: Record<string, string> = { phone_e164: "phone", website_domain: "website" };

const UPLOAD_SCRIPT = `(function(){
var s=document.getElementById('source'),f=document.getElementById('file'),t=document.getElementById('drop-text');
[].forEach.call(document.querySelectorAll('[data-source]'),function(b){b.addEventListener('click',function(){s.value=b.getAttribute('data-source');s.focus()})});
if(f&&t){f.addEventListener('change',function(){if(f.files&&f.files[0]){t.textContent=f.files[0].name+' is ready. Press Upload.'}})}
})();`;

export function registerImportRoutes(app: App, { db, config }: Deps): void {
  app.get("/imports", async (c) => {
    const session = c.get("session");
    const runs = await many<RunRow>(
      db,
      `SELECT r.id, s.name AS source, r.file_name, r.status, r.row_count, r.summary_json, r.error, r.created_at, u.name AS uploader
       FROM runs r JOIN sources s ON s.id = r.source_id LEFT JOIN users u ON u.id = r.created_by
       ORDER BY r.id DESC LIMIT 200`,
    );
    const sources = await many<{ name: string }>(
      db,
      "SELECT s.name FROM sources s ORDER BY (SELECT max(r.id) FROM runs r WHERE r.source_id = s.id) DESC NULLS LAST, s.name LIMIT 6",
    );
    const num = (run: RunRow, value: number | undefined) => (run.summary_json ? count(value ?? 0) : "—");

    return render(
      c,
      <Page c={c} title="Import" active="imports" step="Step 2" sub="Upload a CSV export, match its columns, and the rows become leads.">
        {can(session, "reviewer") ? (
          <form method="post" action="/imports" enctype="multipart/form-data" class="card upload">
            <Csrf session={session} />
            <div style="display:grid;gap:12px;align-content:start">
              <h2 style="margin:0">Upload a file</h2>
              <label>
                Source
                <input id="source" type="text" name="source" required placeholder="e.g. Octoparse: Google Maps gyms" />
              </label>
              {sources.length > 0 ? (
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                  {sources.map((source) => (
                    <button type="button" class="pick" data-source={source.name}>
                      {source.name}
                    </button>
                  ))}
                </div>
              ) : null}
              <span class="muted tiny">
                Use the same source name for files from the same scraper and the column matching is remembered.
              </span>
              <div>
                <button class="primary" type="submit">
                  Upload
                </button>
              </div>
            </div>
            <label class="drop">
              <input id="file" type="file" name="file" accept=".csv,.txt,text/csv" required aria-label="CSV file" />
              <span class="ic">CSV</span>
              <strong id="drop-text">Drop a CSV here, or click to choose</strong>
              <span class="muted tiny">
                CSV only · up to {Math.round(config.maxUploadBytes / 1024 / 1024)} MB and {count(config.maxImportRows)} rows · save
                .xlsx as CSV first
              </span>
            </label>
          </form>
        ) : null}
        <div class="card" style="display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap">
          <div style="display:grid;gap:2px">
            <strong>Or pull straight from Octoparse (Step 1, Scrape)</strong>
            <span class="muted small">
              {config.octoparseApiKey
                ? "Pick a task and bring in the rows it has already collected. Keywords and category stay in the Octoparse task."
                : "Not connected yet. Once the Octoparse API key is added to the server, tasks can be pulled in without a file."}
            </span>
          </div>
          <a class="btn" href="/scrape">
            {config.octoparseApiKey ? "Choose a task" : "How to connect"}
          </a>
        </div>
        <div class="card flush">
          <div class="card-h">
            <h2>Imports</h2>
          </div>
          {runs.length === 0 ? (
            <div class="empty">No files have been uploaded yet.</div>
          ) : (
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>File</th>
                    <th>Status</th>
                    <th class="num">Rows</th>
                    <th class="num">Review</th>
                    <th class="num">Dupes</th>
                    <th class="num">DNC</th>
                    <th class="num">Invalid</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr>
                      <td class="muted">{run.id}</td>
                      <td>
                        <a href={`/imports/${run.id}`} style="font-weight:600;color:var(--ink)">
                          {run.file_name ?? "file"}
                        </a>
                        <div class="muted tiny">
                          {run.source} · {when(run.created_at)}
                          {run.uploader ? ` · ${run.uploader}` : ""}
                        </div>
                      </td>
                      <td>
                        <Chip value={run.status} href={`/imports/${run.id}`} />
                      </td>
                      <td class="num">{count(run.row_count)}</td>
                      <td class="num">{num(run, run.summary_json?.in_review)}</td>
                      <td class="num muted">{num(run, run.summary_json?.duplicate)}</td>
                      <td class="num muted">
                        {run.summary_json ? (run.summary_json.dncChecked ? count(run.summary_json.blocked_dnc) : "not checked") : "—"}
                      </td>
                      <td class="num muted">{num(run, run.summary_json?.invalid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <script dangerouslySetInnerHTML={{ __html: UPLOAD_SCRIPT }} />
      </Page>,
    );
  });

  app.post("/imports", async (c) => {
    const session = need(c, "reviewer");
    const form = c.get("form");
    const upload = file(form, "file");
    if (!upload) throw new ImportError("Choose a CSV file to upload.");
    const text = await readUpload(upload, config.maxUploadBytes);
    const { runId } = await createImport(db, {
      user: session.user,
      sourceName: str(form, "source"),
      fileName: upload.name,
      text,
      maxRows: config.maxImportRows,
    });
    return ok(c, `/imports/${runId}`, "File uploaded. Match its columns below to finish the import.");
  });

  app.get("/imports/:id", async (c) => {
    const session = c.get("session");
    const runId = idParam(c);
    const run = await one<RunRow>(
      db,
      `SELECT r.id, s.name AS source, r.file_name, r.status, r.row_count, r.summary_json, r.error, r.created_at, u.name AS uploader
       FROM runs r JOIN sources s ON s.id = r.source_id LEFT JOIN users u ON u.id = r.created_by WHERE r.id = $1`,
      [runId],
    );
    if (!run) throw new HTTPException(404, { message: "That import does not exist (it may have been deleted)." });
    const title = `Import #${run.id}`;
    const sub = `${run.source} · ${run.file_name ?? "file"} · ${count(run.row_count)} rows · uploaded ${when(run.created_at)}${run.uploader ? ` by ${run.uploader}` : ""}`;

    if (run.status === "needs_mapping" || run.status === "failed") {
      const { headers, mapping } = await getSuggestedMapping(db, runId);
      const settings = await loadSettings(db);
      const required = new Set(settings.requiredFields.map((field) => REQUIRED_AS[field] ?? field));
      const matched = LEAD_FIELDS.filter((field) => mapping[field]).length;
      const sample = await many<{ payload_json: Record<string, string> }>(
        db,
        "SELECT payload_json FROM raw_records WHERE run_id = $1 ORDER BY row_number LIMIT 5",
        [runId],
      );
      return render(
        c,
        <Page c={c} title={title} active="imports" step="Step 2" crumb={`Import / #${run.id}`} sub={sub}>
          {run.status === "failed" ? <div class="note err">The last attempt failed: {run.error}. No leads were saved. You can try again.</div> : null}
          <form method="post" action={`/imports/${run.id}/process`} class="card flush" style="animation:rzFade 180ms ease">
            <Csrf session={session} />
            <div class="card-h" style="align-items:flex-start;padding-bottom:16px">
              <div style="display:grid;gap:2px">
                <h2>Match the columns</h2>
                <span class="muted small">Pick which column of the file holds each field. Fields left as "Not in this file" stay empty.</span>
              </div>
              <span class="muted tiny" style="max-width:360px;text-wrap:pretty">
                {count(matched)} of {LEAD_FIELDS.length} fields were matched from the column names. Check them. Required for a valid
                lead right now: {settings.requiredFields.map((field) => field.replace("phone_e164", "valid phone").replace("website_domain", "website").replace(/_/g, " ")).join(", ") || "nothing"}.
                Numbers with no country code are read as {settings.defaultCountry}.
              </span>
            </div>
            <div class="mapgrid">
              {LEAD_FIELDS.map((field) => (
                <label>
                  <span>
                    {FIELD_LABELS[field]}
                    {required.has(field) ? <span style="color:var(--bad)"> *</span> : null}
                  </span>
                  <select id={`map-${field}`} name={field} disabled={!can(session, "reviewer")} style={required.has(field) && !mapping[field] ? "border-color:#F13C47" : ""}>
                    <option value="">Not in this file</option>
                    {headers.map((header) => (
                      <option value={header} selected={mapping[field] === header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div style="padding:0 24px 20px;display:grid;gap:8px">
              <span class="eyebrow soft">First rows of the file</span>
              <div class="scroll" style="border:1px solid var(--line);border-radius:12px">
                <table class="tiny">
                  <thead>
                    <tr>
                      {headers.map((header) => (
                        <th style="border-top:none">{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sample.map((row) => (
                      <tr>
                        {headers.map((header) => (
                          <td style="white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis">
                            {row.payload_json[header] || <span class="muted">(empty)</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div class="card-f">
              <span class="fill muted small">
                {can(session, "reviewer") ? `Matching is remembered for "${run.source}".` : "A reviewer or admin has to finish this import."}
              </span>
              <a class="btn" href="/imports">
                Later
              </a>
              {can(session, "reviewer") ? (
                <button class="primary lift" type="submit">
                  Import {count(run.row_count)} rows
                </button>
              ) : null}
            </div>
          </form>
          <DeleteCard c={c} runId={run.id} db={db} />
        </Page>,
      );
    }

    const summary = run.summary_json;
    // A file uploaded after this import re-checked its leads, so "not compared" only holds while none is loaded.
    const known = await getKnownState(db);
    const viciCompared = Boolean(summary?.viciChecked) || known.vici.lists > 0;
    const closeCompared = Boolean(summary?.closeChecked) || known.close.lists > 0;
    return render(
      c,
      <Page c={c} title={title} active="imports" step="Step 2" crumb={`Import / #${run.id}`} sub={sub} aside={<Chip value={run.status} />}>
        {summary ? (
          <>
            {!summary.dncChecked ? (
              <div class="note warn">
                <b>These leads were not checked against a DNC list</b>, because none was loaded when the file was imported.
                Upload one on the <a href="/checks">Checks page</a> and every lead that can still be exported is checked.
              </div>
            ) : null}
            {!viciCompared || !closeCompared ? (
              <div class="note warn">
                <b>
                  These leads were not compared with{" "}
                  {[!viciCompared ? "VICIdial" : "", !closeCompared ? "Close" : ""].filter(Boolean).join(" or ")}
                </b>
                , because no export from there has been loaded. Upload one on the <a href="/checks">Checks page</a> and the leads
                are compared.
              </div>
            ) : null}
            <div class="grid">
              {(
                [
                  ["in_review", "Sent to review", ""],
                  ["duplicate", "Duplicates", ""],
                  ["in_vici", "Already in VICIdial", viciCompared ? "" : "Not compared"],
                  ["in_close", "Already in Close", closeCompared ? "" : "Not compared"],
                  ["blocked_dnc", "Blocked by DNC", summary.dncChecked ? "" : "Not checked"],
                  ["invalid", "Invalid rows", ""],
                ] as const
              ).map(([status, label, caveat]) => (
                <a class="stat" href={`/leads?run=${run.id}&status=${status}`}>
                  <b>{count(summary[status] ?? 0)}</b>
                  <strong>{label}</strong>
                  <span>{caveat || "As counted when the file was imported"}</span>
                </a>
              ))}
            </div>
            <p class="muted small">
              Rules used: duplicates matched on {summary.dedupeKeys.join(", ") || "nothing"}; required fields:{" "}
              {summary.requiredFields.join(", ") || "none"}. <a href={`/leads?run=${run.id}`}>See all leads from this import</a>
            </p>
          </>
        ) : null}
        <DeleteCard c={c} runId={run.id} db={db} />
      </Page>,
    );
  });

  app.post("/imports/:id/process", async (c) => {
    const session = need(c, "reviewer");
    const runId = idParam(c);
    const form = c.get("form");
    const mapping: Record<string, unknown> = {};
    for (const field of LEAD_FIELDS) mapping[field] = str(form, field);
    const summary = await processImport(db, { runId, mapping, user: session.user });
    return ok(
      c,
      `/imports/${runId}`,
      `Imported ${count(summary.total)} rows: ${[
        `${count(summary.in_review)} to review`,
        `${count(summary.duplicate)} duplicate`,
        ...(summary.in_vici ? [`${count(summary.in_vici)} already in VICIdial`] : []),
        ...(summary.in_close ? [`${count(summary.in_close)} already in Close`] : []),
        `${count(summary.blocked_dnc)} blocked by DNC`,
        `${count(summary.invalid)} invalid`,
      ].join(", ")}.`,
    );
  });

  app.post("/imports/:id/request-delete", async (c) => {
    const session = need(c, "reviewer");
    const runId = idParam(c);
    await requestApproval(db, { user: session.user, subjectType: "run", subjectId: runId, note: str(c.get("form"), "note") });
    return ok(c, "/approvals", "Delete requested. Nothing is deleted until an admin approves it.");
  });
}

async function DeleteCard({ c, runId, db }: { c: Ctx; runId: number; db: Deps["db"] }) {
  const session = c.get("session");
  if (!can(session, "reviewer")) return null;
  const info = await describeRunDelete(db, runId);
  const pending = await one(db, "SELECT 1 FROM approvals WHERE subject_type = 'run' AND subject_id = $1 AND status = 'pending'", [runId]);
  return (
    <div class="card">
      <h2>Delete this import</h2>
      {info.inExportBatches > 0 ? (
        <p class="muted small">
          {count(info.inExportBatches)} lead(s) from this import are in an export batch, so it cannot be deleted.
        </p>
      ) : pending ? (
        <p class="muted small">
          A delete request is waiting for an admin. <a href="/approvals">Open approvals</a>
        </p>
      ) : (
        <form method="post" action={`/imports/${runId}/request-delete`} style="display:grid;gap:12px">
          <Csrf session={session} />
          <p class="muted small">
            This would remove {count(info.leads)} lead(s) and {count(info.rawRecords)} raw row(s) for good. It cannot be undone.
            {info.duplicatesPointingHere > 0
              ? ` ${count(info.duplicatesPointingHere)} lead(s) from other imports that were marked as duplicates of these would go back to review.`
              : ""}{" "}
            Nothing is deleted until an admin approves the request.
          </p>
          <div class="row">
            <label>
              Why (shown to the approver)
              <input id="note" type="text" name="note" placeholder="e.g. wrong column matching" />
            </label>
            <div class="fit">
              <button class="danger" type="submit">
                Request delete
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

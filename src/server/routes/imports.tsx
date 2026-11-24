import { HTTPException } from "hono/http-exception";
import { requestApproval } from "../../approvals.js";
import { many, one } from "../../db/db.js";
import { describeRunDelete } from "../../deletes.js";
import { createImport, getSuggestedMapping, ImportError, processImport, type RunSummary } from "../../pipeline/importRun.js";
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

export function registerImportRoutes(app: App, { db, config }: Deps): void {
  app.get("/imports", async (c) => {
    const session = c.get("session");
    const runs = await many<RunRow>(
      db,
      `SELECT r.id, s.name AS source, r.file_name, r.status, r.row_count, r.summary_json, r.error, r.created_at, u.name AS uploader
       FROM runs r JOIN sources s ON s.id = r.source_id LEFT JOIN users u ON u.id = r.created_by
       ORDER BY r.id DESC LIMIT 200`,
    );
    const sources = await many<{ name: string }>(db, "SELECT name FROM sources ORDER BY name");

    return render(
      c,
      <Page c={c} title="Imports" active="imports" sub="Upload a CSV export, match its columns, and the rows become leads.">
        {can(session, "reviewer") ? (
          <div class="card">
            <h2>Upload a file</h2>
            <form method="post" action="/imports" enctype="multipart/form-data">
              <Csrf session={session} />
              <div class="row">
                <div>
                  <label for="source">Source</label>
                  <input id="source" type="text" name="source" list="sources" required placeholder="e.g. Octoparse: Google Maps gyms" />
                  <datalist id="sources">
                    {sources.map((source) => (
                      <option value={source.name} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label for="file">CSV file</label>
                  <input id="file" type="file" name="file" accept=".csv,.txt,text/csv" required />
                </div>
                <div class="fit">
                  <button class="primary" type="submit">
                    Upload
                  </button>
                </div>
              </div>
              <p class="muted small">
                CSV only, up to {Math.round(config.maxUploadBytes / 1024 / 1024)} MB and {count(config.maxImportRows)} rows. Use
                the same source name for files from the same scraper and the column matching is remembered.
              </p>
            </form>
          </div>
        ) : null}
        <div class="card">
          <h2>Imports</h2>
          {runs.length === 0 ? (
            <p class="muted">No files have been uploaded yet.</p>
          ) : (
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Import</th>
                    <th>Source</th>
                    <th>File</th>
                    <th>Status</th>
                    <th class="num">Rows</th>
                    <th class="num">To review</th>
                    <th class="num">Duplicate</th>
                    <th class="num">DNC</th>
                    <th class="num">Invalid</th>
                    <th>Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr>
                      <td>
                        <a href={`/imports/${run.id}`}>#{run.id}</a>
                      </td>
                      <td>{run.source}</td>
                      <td>{run.file_name}</td>
                      <td>
                        <Chip value={run.status} />
                      </td>
                      <td class="num">{count(run.row_count)}</td>
                      <td class="num">{run.summary_json ? count(run.summary_json.in_review) : ""}</td>
                      <td class="num">{run.summary_json ? count(run.summary_json.duplicate) : ""}</td>
                      <td class="num">
                        {run.summary_json ? (run.summary_json.dncChecked ? count(run.summary_json.blocked_dnc) : "not checked") : ""}
                      </td>
                      <td class="num">{run.summary_json ? count(run.summary_json.invalid) : ""}</td>
                      <td>
                        {when(run.created_at)}
                        {run.uploader ? ` · ${run.uploader}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
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
      const sample = await many<{ payload_json: Record<string, string> }>(
        db,
        "SELECT payload_json FROM raw_records WHERE run_id = $1 ORDER BY row_number LIMIT 5",
        [runId],
      );
      return render(
        c,
        <Page c={c} title={title} active="imports" sub={sub}>
          {run.status === "failed" ? <div class="note err">The last attempt failed: {run.error}. No leads were saved. You can try again.</div> : null}
          <div class="card">
            <h2>Match the columns</h2>
            <p class="muted small">
              Pick which column of the file holds each field. Fields left as "not in this file" stay empty. Required for a
              valid lead right now: {settings.requiredFields.join(", ") || "nothing"}. Phone numbers with no country code are
              read as {settings.defaultCountry}.
            </p>
            {can(session, "reviewer") ? (
              <form method="post" action={`/imports/${run.id}/process`}>
                <Csrf session={session} />
                <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-bottom:14px">
                  {LEAD_FIELDS.map((field) => (
                    <div>
                      <label for={`map-${field}`}>{FIELD_LABELS[field]}</label>
                      <select id={`map-${field}`} name={field}>
                        <option value="">— not in this file —</option>
                        {headers.map((header) => (
                          <option value={header} selected={mapping[field] === header}>
                            {header}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                <button class="primary" type="submit">
                  Import {count(run.row_count)} rows
                </button>
              </form>
            ) : (
              <p class="muted">A reviewer or admin has to finish this import.</p>
            )}
          </div>
          <div class="card">
            <h2>First rows of the file</h2>
            <div class="scroll">
              <table class="small">
                <thead>
                  <tr>
                    {headers.map((header) => (
                      <th>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sample.map((row) => (
                    <tr>
                      {headers.map((header) => (
                        <td>{row.payload_json[header]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <DeleteCard c={c} runId={run.id} db={db} />
        </Page>,
      );
    }

    const summary = run.summary_json;
    return render(
      c,
      <Page c={c} title={title} active="imports" sub={sub}>
        <p>
          <Chip value={run.status} />
        </p>
        {summary ? (
          <>
            {!summary.dncChecked ? (
              <div class="note warn">
                <b>These leads were not checked against a DNC list</b>, because none was loaded when the file was imported.
                Upload one on the <a href="/dnc">DNC page</a> and every lead that can still be exported is checked.
              </div>
            ) : null}
            <div class="grid" style="margin-bottom:18px">
              {(
                [
                  ["in_review", "Sent to review"],
                  ["duplicate", "Duplicates"],
                  ["blocked_dnc", summary.dncChecked ? "Blocked by DNC" : "Blocked by DNC (not checked)"],
                  ["invalid", "Invalid rows"],
                ] as const
              ).map(([status, label]) => (
                <a class="stat" href={`/leads?run=${run.id}&status=${status}`} style="color:inherit">
                  <b>{count(summary[status])}</b>
                  <span>{label}</span>
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
      `Imported ${count(summary.total)} rows: ${count(summary.in_review)} to review, ${count(summary.duplicate)} duplicate, ${count(summary.blocked_dnc)} blocked by DNC, ${count(summary.invalid)} invalid.`,
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
        <p class="muted">
          {count(info.inExportBatches)} lead(s) from this import are in an export batch, so it cannot be deleted.
        </p>
      ) : pending ? (
        <p class="muted">
          A delete request is waiting for an admin. <a href="/approvals">Open approvals</a>
        </p>
      ) : (
        <form method="post" action={`/imports/${runId}/request-delete`}>
          <Csrf session={session} />
          <p class="small">
            This would remove {count(info.leads)} lead(s) and {count(info.rawRecords)} raw row(s) for good. It cannot be undone.
            {info.duplicatesPointingHere > 0
              ? ` ${count(info.duplicatesPointingHere)} lead(s) from other imports that were marked as duplicates of these would go back to review.`
              : ""}{" "}
            Nothing is deleted until an admin approves the request.
          </p>
          <div class="row">
            <div>
              <label for="note">Why (shown to the approver)</label>
              <input id="note" type="text" name="note" placeholder="e.g. wrong column matching" />
            </div>
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

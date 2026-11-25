import type { Child, FC } from "hono/jsx";
import type { Session } from "../../auth.js";
import { many } from "../../db/db.js";
import { getDncState } from "../../pipeline/dnc.js";
import { getKnownState, KNOWN_KINDS, KNOWN_LABEL, type KnownKind } from "../../pipeline/known.js";
import { loadSettings } from "../../settings.js";
import { can, type App, type Deps } from "../http.js";
import { Chip, count, Csrf, Page, render, when } from "../views.js";

type FileRow = {
  id: number;
  name: string;
  file_name: string | null;
  number_count: number;
  uploaded_at: Date;
  uploader: string | null;
  pending: boolean;
  phone_columns?: string | null;
};

const CheckCard: FC<{
  session: Session;
  title: string;
  loaded: boolean;
  missingTone: string;
  body: Child;
  files: FileRow[];
  fileMeta: (file: FileRow) => string;
  action: string;
  deleteAction: (file: FileRow) => string;
  recheckAction: string;
  cta: string;
  namePlaceholder: string;
  hidden?: [string, string];
}> = ({ session, title, loaded, missingTone, body, files, fileMeta, action, deleteAction, recheckAction, cta, namePlaceholder, hidden }) => {
  const reviewer = can(session, "reviewer");
  return (
    <div class="card" style="display:grid;gap:14px;align-content:start">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        <h2 style="margin:0">{title}</h2>
        {loaded ? <Chip value="loaded" /> : <Chip value="missing" label="Not loaded" tone={missingTone} />}
      </div>
      <span class="muted small" style="text-wrap:pretty">
        {body}
      </span>
      {files.map((file) => (
        <div class="filerow">
          <strong class="clip">{file.name}</strong>
          {file.pending ? (
            <a class="tiny" href="/approvals" style="font-weight:600">
              Delete requested
            </a>
          ) : reviewer ? (
            <form method="post" action={deleteAction(file)} class="inline">
              <Csrf session={session} />
              <button class="link" type="submit">
                Request delete
              </button>
            </form>
          ) : (
            <span></span>
          )}
          <span class="muted tiny" style="grid-column:1 / -1">
            {fileMeta(file)}
          </span>
        </div>
      ))}
      {reviewer ? (
        <form method="post" action={action} enctype="multipart/form-data" style="display:grid;gap:10px">
          <Csrf session={session} />
          {hidden ? <input type="hidden" name={hidden[0]} value={hidden[1]} /> : null}
          <label>
            Name for this file
            <input type="text" name="name" required placeholder={namePlaceholder} />
          </label>
          <input type="file" name="file" accept=".csv,.txt,.tsv,text/csv,text/plain" required aria-label={`${title} file`} />
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class={loaded ? "sm" : "primary sm"} type="submit">
              {cta}
            </button>
            {loaded ? (
              <button class="sm" type="submit" formaction={recheckAction} formenctype="application/x-www-form-urlencoded" formnovalidate>
                Re-check all leads now
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
};

export function registerCheckRoutes(app: App, { db, config }: Deps): void {
  app.get("/checks", async (c) => {
    const session = c.get("session");
    const dnc = await getDncState(db);
    const known = await getKnownState(db);
    const settings = await loadSettings(db);
    const dncLists = await many<FileRow>(
      db,
      `SELECT d.id, d.name, d.file_name, d.number_count, d.uploaded_at, u.name AS uploader,
              EXISTS (SELECT 1 FROM approvals a WHERE a.subject_type = 'dnc_list' AND a.subject_id = d.id AND a.status = 'pending') AS pending
       FROM dnc_lists d LEFT JOIN users u ON u.id = d.uploaded_by ORDER BY d.id DESC`,
    );
    const knownLists = await many<FileRow & { kind: KnownKind }>(
      db,
      `SELECT k.id, k.kind, k.name, k.file_name, k.number_count, k.phone_columns, k.uploaded_at, u.name AS uploader,
              EXISTS (SELECT 1 FROM approvals a WHERE a.subject_type = 'known_list' AND a.subject_id = k.id AND a.status = 'pending') AS pending
       FROM known_lists k LEFT JOIN users u ON u.id = k.uploaded_by ORDER BY k.id DESC`,
    );
    const heldBy = await many<{ status: string; count: number }>(
      db,
      "SELECT status, count(*)::int AS count FROM leads WHERE status IN ('blocked_dnc', 'in_vici', 'in_close') GROUP BY status",
    );
    const held = (status: string) => heldBy.find((row) => row.status === status)?.count ?? 0;
    const meta = (file: FileRow) =>
      `${count(file.number_count)} number(s) · ${file.file_name ?? "file"} · uploaded ${when(file.uploaded_at)}${file.uploader ? ` by ${file.uploader}` : ""}`;

    return render(
      c,
      <Page
        c={c}
        title="Checks"
        active="checks"
        step="Step 2"
        sub="Leads are matched against the files you upload here, by phone number only. Each file is a snapshot as of the day it was exported. Uploading a new one re-checks every lead that can still be exported."
      >
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;align-items:start">
          <CheckCard
            session={session}
            title="Do-not-call lists"
            loaded={dnc.listCount > 0}
            missingTone="warn"
            body={
              dnc.listCount > 0 ? (
                <>
                  {count(dnc.listCount)} list(s), {count(dnc.numberCount)} distinct number(s). Numbers on a loaded list are blocked at
                  import and checked again when a batch is downloaded. {count(held("blocked_dnc"))} lead(s) blocked now. Which lists
                  the law requires (federal, state, internal) has not been decided in this app; someone responsible for compliance
                  must confirm that before any dialing.
                </>
              ) : (
                <>
                  <b>No DNC list is loaded.</b> Nothing in the app has been scrubbed, and exports say so. Which lists the law
                  requires (federal, state, internal) has not been decided in this app; someone responsible for compliance must
                  confirm that before any dialing.
                </>
              )
            }
            files={dncLists}
            fileMeta={meta}
            action="/dnc"
            deleteAction={(file) => `/dnc/${file.id}/request-delete`}
            recheckAction="/dnc/recheck"
            cta={dnc.listCount > 0 ? "Add another list" : "Upload a DNC list"}
            namePlaceholder="e.g. Internal DNC, Nov 2026"
          />
          {KNOWN_KINDS.map((kind) => {
            const label = KNOWN_LABEL[kind];
            const state = known[kind];
            return (
              <CheckCard
                session={session}
                title={`${label} export`}
                loaded={state.lists > 0}
                missingTone=""
                body={
                  state.lists > 0
                    ? `${count(state.numbers)} number(s) from ${count(state.lists)} file(s), newest uploaded ${when(state.latest)}. Leads already in ${label} are held back: ${count(held(kind === "vici" ? "in_vici" : "in_close"))} now. A record added to ${label} after the export is not known here.`
                    : `Leads are not compared with what is already in ${label}. Upload an export from ${label} and matching leads are held back.`
                }
                files={knownLists.filter((file) => file.kind === kind)}
                fileMeta={(file) => `${meta(file)} · read from ${file.phone_columns ?? "every column (no phone header found)"}`}
                action="/existing"
                deleteAction={(file) => `/existing/${file.id}/request-delete`}
                recheckAction="/existing/recheck"
                cta={state.lists > 0 ? "Add a newer export" : `Upload ${label} export`}
                namePlaceholder={`e.g. ${label} all lists, 24 Nov 2026`}
                hidden={["kind", kind]}
              />
            );
          })}
        </div>
        <p class="muted tiny" style="max-width:none">
          Files: CSV or text, up to {Math.round(config.maxUploadBytes / 1024 / 1024)} MB. Numbers with no country code are read as{" "}
          {settings.defaultCountry}. A DNC file is scanned in every column. For a VICIdial or Close export with a header row, only
          columns whose name contains "phone", "mobile", "cell" or "tel" are read; with no header row every column is scanned, and
          each file above says which was done. The app does not connect to VICIdial or Close. Deleting a file needs an admin's
          approval, and the file stays in force until then.
        </p>
      </Page>,
    );
  });
}

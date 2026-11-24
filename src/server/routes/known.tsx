import { requestApproval } from "../../approvals.js";
import { many } from "../../db/db.js";
import { getKnownState, KNOWN_KINDS, KNOWN_LABEL, KnownError, recheckKnown, uploadKnownList, type KnownKind } from "../../pipeline/known.js";
import { loadSettings } from "../../settings.js";
import { can, file, idParam, need, ok, readUpload, str, type App, type Deps } from "../http.js";
import { count, Csrf, Page, render, when } from "../views.js";

export function registerKnownRoutes(app: App, { db, config }: Deps): void {
  app.get("/existing", async (c) => {
    const session = c.get("session");
    const state = await getKnownState(db);
    const settings = await loadSettings(db);
    const lists = await many<{
      id: number;
      kind: KnownKind;
      name: string;
      file_name: string | null;
      number_count: number;
      phone_columns: string | null;
      uploaded_at: Date;
      uploader: string | null;
      pending: boolean;
    }>(
      db,
      `SELECT k.id, k.kind, k.name, k.file_name, k.number_count, k.phone_columns, k.uploaded_at, u.name AS uploader,
              EXISTS (SELECT 1 FROM approvals a WHERE a.subject_type = 'known_list' AND a.subject_id = k.id AND a.status = 'pending') AS pending
       FROM known_lists k LEFT JOIN users u ON u.id = k.uploaded_by ORDER BY k.id DESC`,
    );

    return render(
      c,
      <Page
        c={c}
        title="Existing records"
        active="known"
        sub="Leads whose phone number is already in VICIdial or Close are held back, so they are not loaded twice."
      >
        <div class="grid" style="margin-bottom:18px">
          {KNOWN_KINDS.map((kind) => (
            <div class="stat">
              <b>{state[kind].lists === 0 ? "Not loaded" : count(state[kind].numbers)}</b>
              <span>
                {state[kind].lists === 0
                  ? `${KNOWN_LABEL[kind]}: no file, so no lead has been compared with it`
                  : `${KNOWN_LABEL[kind]} number(s) from ${count(state[kind].lists)} file(s), newest ${when(state[kind].latest)}`}
              </span>
            </div>
          ))}
        </div>
        <div class="note warn small">
          The app does not connect to VICIdial or Close. It knows only the numbers in the files uploaded here, as of the day
          each file was exported. A record added there since then is not known, so upload a fresh export before a big
          import. Matching is by phone number only.
        </div>

        {can(session, "reviewer") ? (
          <div class="card">
            <h2>Upload an export</h2>
            <form method="post" action="/existing" enctype="multipart/form-data">
              <Csrf session={session} />
              <div class="row">
                <div class="fit">
                  <label for="kind">Exported from</label>
                  <select id="kind" name="kind" required>
                    {KNOWN_KINDS.map((kind) => (
                      <option value={kind}>{KNOWN_LABEL[kind]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label for="name">Name</label>
                  <input id="name" type="text" name="name" required placeholder="e.g. VICIdial all lists, 24 Nov 2026" />
                </div>
                <div>
                  <label for="file">File (CSV or text, any delimiter)</label>
                  <input id="file" type="file" name="file" accept=".csv,.txt,.tsv,text/csv,text/plain" required />
                </div>
                <div class="fit">
                  <button class="primary" type="submit">
                    Upload and check leads
                  </button>
                </div>
              </div>
              <p class="muted small">
                Up to {Math.round(config.maxUploadBytes / 1024 / 1024)} MB. If the file has a header row, only columns whose
                name contains "phone", "mobile", "cell" or "tel" are read. With no header row, every column is scanned for
                phone numbers. Numbers with no country code are read as {settings.defaultCountry}. After the upload, every
                lead still in review, approved, rejected or marked duplicate is compared again.
              </p>
            </form>
          </div>
        ) : null}

        <div class="card">
          <h2>Loaded files</h2>
          {lists.length === 0 ? (
            <p class="muted">None.</p>
          ) : (
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>From</th>
                    <th>Name</th>
                    <th>File</th>
                    <th class="num">Numbers</th>
                    <th>Read from</th>
                    <th>Uploaded</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {lists.map((item) => (
                    <tr>
                      <td>{KNOWN_LABEL[item.kind]}</td>
                      <td>{item.name}</td>
                      <td>{item.file_name}</td>
                      <td class="num">{count(item.number_count)}</td>
                      <td class="small">{item.phone_columns ?? "every column (no phone header found)"}</td>
                      <td>
                        {when(item.uploaded_at)}
                        {item.uploader ? ` · ${item.uploader}` : ""}
                      </td>
                      <td>
                        {item.pending ? (
                          <a href="/approvals">Delete requested</a>
                        ) : can(session, "reviewer") ? (
                          <form method="post" action={`/existing/${item.id}/request-delete`} class="inline">
                            <Csrf session={session} />
                            <button class="danger" type="submit">
                              Request delete
                            </button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {can(session, "reviewer") && lists.length > 0 ? (
            <form method="post" action="/existing/recheck" style="margin-top:14px">
              <Csrf session={session} />
              <button type="submit">Re-check all leads now</button>
            </form>
          ) : null}
        </div>
      </Page>,
    );
  });

  app.post("/existing", async (c) => {
    const session = need(c, "reviewer");
    const form = c.get("form");
    const upload = file(form, "file");
    if (!upload) throw new KnownError("Choose a file to upload.");
    const settings = await loadSettings(db);
    const result = await uploadKnownList(db, {
      user: session.user,
      kind: str(form, "kind"),
      name: str(form, "name"),
      fileName: upload.name,
      text: await readUpload(upload, config.maxUploadBytes),
      defaultCountry: settings.defaultCountry,
    });
    const from = result.columns ? `read from ${result.columns.join(", ")}` : "no phone header found, so every column was scanned";
    const without = result.rowsWithoutNumber > 0 ? ` ${count(result.rowsWithoutNumber)} row(s) had no valid number.` : "";
    return ok(
      c,
      "/existing",
      `${count(result.numbers.length)} number(s) loaded from ${count(result.rows)} row(s) (${from}).${without} ${count(result.recheck.newlyMarked)} lead(s) newly marked as already there.`,
    );
  });

  app.post("/existing/recheck", async (c) => {
    const session = need(c, "reviewer");
    const state = await getKnownState(db);
    if (state.vici.lists + state.close.lists === 0) throw new KnownError("There is no file to check against.");
    const result = await recheckKnown(db, session.user);
    return ok(c, "/existing", `${count(result.newlyMarked)} lead(s) newly marked as already in VICIdial or Close.`);
  });

  app.post("/existing/:id/request-delete", async (c) => {
    const session = need(c, "reviewer");
    await requestApproval(db, { user: session.user, subjectType: "known_list", subjectId: idParam(c) });
    return ok(c, "/approvals", "Delete requested. The file stays in force until an admin approves.");
  });
}

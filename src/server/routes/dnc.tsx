import { requestApproval } from "../../approvals.js";
import { many } from "../../db/db.js";
import { DncError, getDncState, recheckDnc, uploadDncList } from "../../pipeline/dnc.js";
import { loadSettings } from "../../settings.js";
import { can, file, idParam, need, ok, readUpload, str, type App, type Deps } from "../http.js";
import { count, Csrf, Page, render, when } from "../views.js";

export function registerDncRoutes(app: App, { db, config }: Deps): void {
  app.get("/dnc", async (c) => {
    const session = c.get("session");
    const state = await getDncState(db);
    const settings = await loadSettings(db);
    const lists = await many<{ id: number; name: string; file_name: string | null; number_count: number; uploaded_at: Date; uploader: string | null; pending: boolean }>(
      db,
      `SELECT d.id, d.name, d.file_name, d.number_count, d.uploaded_at, u.name AS uploader,
              EXISTS (SELECT 1 FROM approvals a WHERE a.subject_type = 'dnc_list' AND a.subject_id = d.id AND a.status = 'pending') AS pending
       FROM dnc_lists d LEFT JOIN users u ON u.id = d.uploaded_by ORDER BY d.id DESC`,
    );

    return render(
      c,
      <Page c={c} title="Do-not-call lists" active="dnc" sub="Numbers on these lists are blocked at import and again at export.">
        {state.listCount === 0 ? (
          <div class="note warn">
            <b>No DNC list is loaded.</b> Until one is, no lead has been scrubbed, and exports say so.
          </div>
        ) : (
          <p>
            {count(state.listCount)} list(s) loaded, {count(state.numberCount)} distinct number(s).
          </p>
        )}
        <div class="note warn small">
          This page only compares numbers with the files uploaded here. Which lists the law requires (federal, state,
          internal) has not been decided in this app. Someone responsible for compliance must confirm that before any
          dialing.
        </div>

        {can(session, "reviewer") ? (
          <div class="card">
            <h2>Upload a list</h2>
            <form method="post" action="/dnc" enctype="multipart/form-data">
              <Csrf session={session} />
              <div class="row">
                <div>
                  <label for="name">List name</label>
                  <input id="name" type="text" name="name" required placeholder="e.g. Internal DNC, Nov 2026" />
                </div>
                <div>
                  <label for="file">File (CSV or one number per line)</label>
                  <input id="file" type="file" name="file" accept=".csv,.txt,text/csv,text/plain" required />
                </div>
                <div class="fit">
                  <button class="primary" type="submit">
                    Upload and check leads
                  </button>
                </div>
              </div>
              <p class="muted small">
                Every phone number found in any column is added. Numbers with no country code are read as{" "}
                {settings.defaultCountry}. After the upload, every lead that can still be exported is checked again.
              </p>
            </form>
          </div>
        ) : null}

        <div class="card">
          <h2>Loaded lists</h2>
          {lists.length === 0 ? (
            <p class="muted">None.</p>
          ) : (
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>List</th>
                    <th>File</th>
                    <th class="num">Numbers</th>
                    <th>Uploaded</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {lists.map((item) => (
                    <tr>
                      <td>{item.name}</td>
                      <td>{item.file_name}</td>
                      <td class="num">{count(item.number_count)}</td>
                      <td>
                        {when(item.uploaded_at)}
                        {item.uploader ? ` · ${item.uploader}` : ""}
                      </td>
                      <td>
                        {item.pending ? (
                          <a href="/approvals">Delete requested</a>
                        ) : can(session, "reviewer") ? (
                          <form method="post" action={`/dnc/${item.id}/request-delete`} class="inline">
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
            <form method="post" action="/dnc/recheck" style="margin-top:14px">
              <Csrf session={session} />
              <button type="submit">Re-check all leads now</button>
            </form>
          ) : null}
        </div>
      </Page>,
    );
  });

  app.post("/dnc", async (c) => {
    const session = need(c, "reviewer");
    const form = c.get("form");
    const upload = file(form, "file");
    if (!upload) throw new DncError("Choose a file to upload.");
    const settings = await loadSettings(db);
    const result = await uploadDncList(db, {
      user: session.user,
      name: str(form, "name"),
      fileName: upload.name,
      text: await readUpload(upload, config.maxUploadBytes),
      defaultCountry: settings.defaultCountry,
    });
    const unreadable =
      result.unreadable.length > 0
        ? ` ${count(result.unreadable.length)} line(s) had no valid number and were skipped, starting with: ${result.unreadable.slice(0, 3).join(" | ")}.`
        : "";
    return ok(
      c,
      "/dnc",
      `${count(result.numbers)} number(s) loaded. ${count(result.recheck.checked)} lead(s) checked, ${count(result.recheck.newlyBlocked)} newly blocked.${unreadable}`,
    );
  });

  app.post("/dnc/recheck", async (c) => {
    const session = need(c, "reviewer");
    const state = await getDncState(db);
    if (state.listCount === 0) throw new DncError("There is no DNC list to check against.");
    const result = await recheckDnc(db, session.user);
    return ok(c, "/dnc", `${count(result.checked)} lead(s) checked, ${count(result.newlyBlocked)} newly blocked.`);
  });

  app.post("/dnc/:id/request-delete", async (c) => {
    const session = need(c, "reviewer");
    await requestApproval(db, { user: session.user, subjectType: "dnc_list", subjectId: idParam(c) });
    return ok(c, "/approvals", "Delete requested. The list stays in force until an admin approves.");
  });
}

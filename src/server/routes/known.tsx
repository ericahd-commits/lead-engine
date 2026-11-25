import { requestApproval } from "../../approvals.js";
import { getKnownState, KnownError, recheckKnown, uploadKnownList } from "../../pipeline/known.js";
import { loadSettings } from "../../settings.js";
import { file, idParam, need, ok, readUpload, str, type App, type Deps } from "../http.js";
import { count } from "../views.js";

// The VICIdial and Close exports are shown on the Checks screen; these are the actions behind it.
export function registerKnownRoutes(app: App, { db, config }: Deps): void {
  app.get("/existing", (c) => c.redirect("/checks", 303));

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
      "/checks",
      `${count(result.numbers.length)} number(s) loaded from ${count(result.rows)} row(s) (${from}).${without} ${count(result.recheck.newlyMarked)} lead(s) newly marked as already there.`,
    );
  });

  app.post("/existing/recheck", async (c) => {
    const session = need(c, "reviewer");
    const state = await getKnownState(db);
    if (state.vici.lists + state.close.lists === 0) throw new KnownError("There is no file to check against.");
    const result = await recheckKnown(db, session.user);
    return ok(c, "/checks", `${count(result.newlyMarked)} lead(s) newly marked as already in VICIdial or Close.`);
  });

  app.post("/existing/:id/request-delete", async (c) => {
    const session = need(c, "reviewer");
    await requestApproval(db, { user: session.user, subjectType: "known_list", subjectId: idParam(c) });
    return ok(c, "/approvals", "Delete requested. The file stays in force until an admin approves.");
  });
}

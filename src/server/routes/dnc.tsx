import { requestApproval } from "../../approvals.js";
import { DncError, getDncState, recheckDnc, uploadDncList } from "../../pipeline/dnc.js";
import { loadSettings } from "../../settings.js";
import { file, idParam, need, ok, readUpload, str, type App, type Deps } from "../http.js";
import { count } from "../views.js";

// The DNC lists are shown on the Checks screen; these are the actions behind it.
export function registerDncRoutes(app: App, { db, config }: Deps): void {
  app.get("/dnc", (c) => c.redirect("/checks", 303));

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
      "/checks",
      `${count(result.numbers)} number(s) loaded. ${count(result.recheck.checked)} lead(s) checked, ${count(result.recheck.newlyBlocked)} newly blocked.${unreadable}`,
    );
  });

  app.post("/dnc/recheck", async (c) => {
    const session = need(c, "reviewer");
    const state = await getDncState(db);
    if (state.listCount === 0) throw new DncError("There is no DNC list to check against.");
    const result = await recheckDnc(db, session.user);
    return ok(c, "/checks", `${count(result.checked)} lead(s) checked, ${count(result.newlyBlocked)} newly blocked.`);
  });

  app.post("/dnc/:id/request-delete", async (c) => {
    const session = need(c, "reviewer");
    await requestApproval(db, { user: session.user, subjectType: "dnc_list", subjectId: idParam(c) });
    return ok(c, "/approvals", "Delete requested. The list stays in force until an admin approves.");
  });
}

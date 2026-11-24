import { decideApproval, listApprovals, type ApprovalListItem } from "../../approvals.js";
import { can, idParam, need, ok, str, withMessage, type App, type Deps } from "../http.js";
import { Chip, Csrf, Estimate, Page, render, when } from "../views.js";

const WHAT: Record<string, string> = {
  export_batch: "Export a batch of leads",
  run: "Delete an import and its leads",
  dnc_list: "Delete a do-not-call list",
  known_list: "Delete a VICIdial / Close file",
};

function subjectLink(item: ApprovalListItem): string | null {
  if (item.subject_type === "export_batch") return `/exports/${item.subject_id}`;
  if (item.subject_type === "run" && item.status === "pending") return `/imports/${item.subject_id}`;
  return null;
}

export function registerApprovalRoutes(app: App, { db, config }: Deps): void {
  app.get("/approvals", async (c) => {
    const session = c.get("session");
    const all = await listApprovals(db, 200);
    const pending = all.filter((item) => item.status === "pending");
    const decided = all.filter((item) => item.status !== "pending");
    const admin = can(session, "admin");

    return render(
      c,
      <Page
        c={c}
        title="Approvals"
        active="approvals"
        sub="Exports and deletes happen only after an admin approves them here. Nothing else counts as approval."
      >
        {config.requireSecondApprover ? (
          <div class="note warn small">Two-person rule is on: the person who asked cannot be the one who approves.</div>
        ) : null}
        <h2>Waiting for a decision</h2>
        {pending.length === 0 ? <div class="card muted">Nothing is waiting.</div> : null}
        {pending.map((item) => {
          const link = subjectLink(item);
          const own = config.requireSecondApprover && item.requested_by === session.user.id;
          return (
            <div class="card">
              <h2>
                {WHAT[item.subject_type] ?? item.subject_type} {link ? <a href={link}>(open)</a> : null}
              </h2>
              <p class="muted small">
                Requested by {item.requester_name} on {when(item.requested_at)}
                {item.note ? ` · "${item.note}"` : ""}
              </p>
              <Estimate data={item.estimate_json} />
              {item.estimate_json.dncNeverLoaded === true ? (
                <div class="note warn" style="margin-top:12px">
                  <b>No DNC list is loaded.</b> Approving this exports leads that have not been scrubbed against any
                  do-not-call list.
                </div>
              ) : null}
              {admin && !own ? (
                <form method="post" action={`/approvals/${item.id}/decide`} style="margin-top:14px">
                  <Csrf session={session} />
                  <div class="row">
                    <div>
                      <label for={`note-${item.id}`}>Note (optional)</label>
                      <input id={`note-${item.id}`} type="text" name="note" />
                    </div>
                    <div class="fit">
                      <button class="good" type="submit" name="decision" value="approve">
                        {item.action_type === "delete" ? "Approve and delete now" : "Approve"}
                      </button>{" "}
                      <button class="danger" type="submit" name="decision" value="reject">
                        Reject
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                <p class="muted small" style="margin-bottom:0">
                  {own ? "You asked for this, so another admin has to decide." : "An admin has to decide this."}
                </p>
              )}
            </div>
          );
        })}

        <h2 style="margin-top:26px">Decided</h2>
        <div class="card">
          {decided.length === 0 ? (
            <p class="muted">No decisions yet.</p>
          ) : (
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Outcome</th>
                    <th>Asked by</th>
                    <th>Decided by</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {decided.map((item) => {
                    const link = subjectLink(item);
                    const label = `${WHAT[item.subject_type] ?? item.subject_type} #${item.subject_id}`;
                    return (
                      <tr>
                        <td>{link ? <a href={link}>{label}</a> : label}</td>
                        <td>
                          <Chip value={item.status === "used" ? "approved" : item.status} />
                        </td>
                        <td>
                          {item.requester_name}
                          <div class="small muted">{when(item.requested_at)}</div>
                        </td>
                        <td>
                          {item.decider_name ?? <span class="muted">—</span>}
                          <div class="small muted">{when(item.decided_at)}</div>
                        </td>
                        <td>{item.decision_note}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Page>,
    );
  });

  app.post("/approvals/:id/decide", async (c) => {
    const session = need(c, "admin");
    const form = c.get("form");
    const decision = str(form, "decision");
    if (decision !== "approve" && decision !== "reject") return c.redirect(withMessage("/approvals", "err", "Choose approve or reject."), 303);
    const result = await decideApproval(db, config, {
      user: session.user,
      approvalId: idParam(c),
      approve: decision === "approve",
      note: str(form, "note"),
    });
    if (result.outcome === "void") return c.redirect(withMessage("/approvals", "err", result.message), 303);
    return ok(c, "/approvals", result.message);
  });
}

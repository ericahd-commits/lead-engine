import { decideApproval, listApprovals, type ApprovalListItem } from "../../approvals.js";
import { can, idParam, need, ok, str, withMessage, type App, type Deps } from "../http.js";
import { Chip, Csrf, Estimate, Page, render, when } from "../views.js";

const WHAT: Record<string, string> = {
  export_batch: "Export a batch of leads",
  run: "Delete an import and its leads",
  dnc_list: "Delete a do-not-call list",
  known_list: "Delete a VICIdial / Close file",
};

const KIND: Record<string, string> = {
  export_batch: "Export",
  run: "Delete an import",
  dnc_list: "Delete a DNC list",
  known_list: "Delete a VICIdial / Close file",
};

/** One line naming what is being asked for, e.g. "Export a batch of leads #3". */
export function approvalTitle(item: ApprovalListItem): string {
  return `${WHAT[item.subject_type] ?? item.subject_type} #${item.subject_id}`;
}

function subjectLink(item: ApprovalListItem): string | null {
  if (item.subject_type === "export_batch") return `/exports/${item.subject_id}`;
  if (item.subject_type === "run" && item.status === "pending") return `/imports/${item.subject_id}`;
  if ((item.subject_type === "dnc_list" || item.subject_type === "known_list") && item.status === "pending") return "/checks";
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
          <div class="note warn">Two-person rule is on: the person who asked cannot be the one who approves.</div>
        ) : null}
        {pending.length === 0 ? (
          <div class="card empty" style="display:grid;gap:4px">
            <strong style="color:var(--ink)">Nothing is waiting</strong>
            <span class="small">Export and delete requests show up here for an admin to decide.</span>
          </div>
        ) : null}
        {pending.map((item) => {
          const link = subjectLink(item);
          const own = config.requireSecondApprover && item.requested_by === session.user.id;
          return (
            <form method="post" action={`/approvals/${item.id}/decide`} class="card flush">
              <Csrf session={session} />
              <div class="pad" style="display:grid;gap:14px">
                <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
                  <div style="display:grid;gap:2px;min-width:0">
                    <span class="eyebrow">{KIND[item.subject_type] ?? item.subject_type}</span>
                    <h2 style="margin:0;font-size:18px">
                      {approvalTitle(item)}{" "}
                      {link ? (
                        <a class="small" href={link} style="font-weight:600">
                          Open
                        </a>
                      ) : null}
                    </h2>
                    <span class="muted small">
                      Requested by {item.requester_name} on {when(item.requested_at)}
                      {item.note ? ` · "${item.note}"` : ""}
                    </span>
                  </div>
                  <Chip value="pending" />
                </div>
                <Estimate data={item.estimate_json} />
                {item.estimate_json.dncNeverLoaded === true ? (
                  <div class="note warn">
                    <b>No DNC list is loaded.</b> Approving this exports leads that have not been scrubbed against any
                    do-not-call list.
                  </div>
                ) : null}
              </div>
              <div class="card-f">
                {admin && !own ? (
                  <>
                    <input
                      class="fill"
                      type="text"
                      name="note"
                      placeholder="Note (optional)"
                      aria-label="Note for this decision"
                      style="width:auto"
                    />
                    {/* Pressing Enter in the note box must never count as a decision. */}
                    <button type="submit" name="decision" value="" hidden tabindex={-1} aria-hidden="true"></button>
                    <button class="danger" type="submit" name="decision" value="reject">
                      Reject
                    </button>
                    <button class="primary lift" type="submit" name="decision" value="approve">
                      {item.action_type === "delete" ? "Approve and delete now" : "Approve"}
                    </button>
                  </>
                ) : (
                  <span class="fill muted small">
                    {own ? "You asked for this, so another admin has to decide." : "An admin has to decide this."}
                  </span>
                )}
              </div>
            </form>
          );
        })}

        <div class="card flush">
          <div class="card-h">
            <h2>Decided</h2>
          </div>
          {decided.length === 0 ? (
            <div class="empty">No decisions yet.</div>
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
                    const label = approvalTitle(item);
                    return (
                      <tr>
                        <td>{link ? <a href={link}>{label}</a> : label}</td>
                        <td>
                          <Chip value={item.status === "used" ? "approved" : item.status} />
                        </td>
                        <td>
                          {item.requester_name}
                          <div class="tiny muted">{when(item.requested_at)}</div>
                        </td>
                        <td>
                          {item.decider_name ?? <span class="muted">—</span>}
                          <div class="tiny muted">{when(item.decided_at)}</div>
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

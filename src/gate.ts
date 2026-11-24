import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { one, type Db } from "./db/db.js";

// Raised whenever a gated action is attempted without a valid human approval.
export class GateError extends Error {}

export type ActionType = "import" | "spend" | "delete";

export function snapshotHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type ApprovalRow = {
  id: number;
  action_type: ActionType;
  subject_type: string;
  subject_id: number;
  status: "pending" | "approved" | "rejected" | "void" | "used";
  snapshot_hash: string;
  requested_by: number;
  approved_by: number | null;
};

// The check every gated action makes immediately before it runs. It passes only when a person
// with an active admin account approved exactly what is about to happen: same subject, same
// snapshot. Nothing else - no flag, no service, no other job - can stand in for that row.
export async function assertApproved(
  db: Db,
  config: Pick<Config, "requireSecondApprover">,
  input: { actionType: ActionType; subjectType: string; subjectId: number; snapshotHash: string; allowUsed?: boolean },
): Promise<ApprovalRow> {
  const approval = await one<ApprovalRow & { approver_active: boolean | null; approver_role: string | null }>(
    db,
    `SELECT a.id, a.action_type, a.subject_type, a.subject_id, a.status, a.snapshot_hash,
            a.requested_by, a.approved_by, u.active AS approver_active, u.role AS approver_role
     FROM approvals a LEFT JOIN users u ON u.id = a.approved_by
     WHERE a.action_type = $1 AND a.subject_type = $2 AND a.subject_id = $3
       AND a.status IN ('approved', 'used')
     ORDER BY a.id DESC LIMIT 1`,
    [input.actionType, input.subjectType, input.subjectId],
  );

  if (!approval) throw new GateError("This has not been approved by a person yet.");
  if (approval.status === "used" && !input.allowUsed) throw new GateError("That approval has already been used.");
  if (approval.approved_by === null || approval.approver_role === null) {
    throw new GateError("The approval is not tied to a person, so it does not count.");
  }
  if (config.requireSecondApprover && approval.approved_by === approval.requested_by) {
    throw new GateError("The approver must be a different person from the one who asked.");
  }
  if (approval.snapshot_hash !== input.snapshotHash) {
    throw new GateError("This changed after it was approved, so the approval no longer applies. Ask for approval again.");
  }
  return approval;
}

// For adapters that write to or spend on an outside system. None exist in this build; the check
// is here so the first one cannot be written without it.
export function assertExternalWritesEnabled(config: Pick<Config, "externalWritesEnabled">): void {
  if (!config.externalWritesEnabled) {
    throw new GateError("External writes are switched off (EXTERNAL_WRITES_ENABLED=false).");
  }
}

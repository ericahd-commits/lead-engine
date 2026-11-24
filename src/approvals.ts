import { logAudit } from "./audit.js";
import type { Config } from "./config.js";
import { many, one, type Db } from "./db/db.js";
import { describeDncListDelete, describeRunDelete, executeDncListDelete, executeRunDelete } from "./deletes.js";
import { batchSnapshot, checkBatch, getBatch } from "./exports.js";
import { assertApproved, GateError, snapshotHash, type ActionType } from "./gate.js";

export class ApprovalError extends Error {}

export type SubjectType = "export_batch" | "run" | "dnc_list";
type User = { id: number; email: string; role: string; active?: boolean };

const ACTION_FOR: Record<SubjectType, ActionType> = { export_batch: "import", run: "delete", dnc_list: "delete" };

// What a request covers, as shown to the approver, and the hash that pins it.
async function describeSubject(
  db: Db,
  subjectType: SubjectType,
  subjectId: number,
): Promise<{ hash: string; estimate: Record<string, unknown> }> {
  if (subjectType === "export_batch") {
    const batch = await getBatch(db, subjectId);
    const check = await checkBatch(db, subjectId);
    return {
      hash: await batchSnapshot(db, subjectId),
      estimate: {
        batch: batch.name,
        target: batch.target,
        targetRef: batch.target_ref,
        leads: check.leadCount,
        dncLists: check.dncLists,
        dncNeverLoaded: check.dncNeverLoaded,
        cost: "None. This produces a CSV file and calls no outside service.",
      },
    };
  }
  if (subjectType === "run") {
    const info = await describeRunDelete(db, subjectId);
    return { hash: snapshotHash(info), estimate: info };
  }
  const info = await describeDncListDelete(db, subjectId);
  return { hash: snapshotHash(info), estimate: info };
}

export async function requestApproval(
  db: Db,
  input: { user: User; subjectType: SubjectType; subjectId: number; note?: string | null },
): Promise<{ approvalId: number }> {
  if (input.user.role !== "admin" && input.user.role !== "reviewer") {
    throw new ApprovalError("Your account can view but not request changes.");
  }

  return await db.tx(async (tx) => {
    if (input.subjectType === "export_batch") {
      const batch = await getBatch(tx, input.subjectId);
      if (batch.status !== "draft") throw new ApprovalError("Approval has already been requested for this batch.");
      const check = await checkBatch(tx, input.subjectId);
      if (check.leadCount === 0) throw new ApprovalError("The batch is empty.");
      if (check.ineligible.length > 0) {
        throw new ApprovalError(`Remove the ${check.ineligible.length} lead(s) that can no longer be exported first.`);
      }
    }
    if (input.subjectType === "run") {
      const info = await describeRunDelete(tx, input.subjectId);
      if (info.inExportBatches > 0) {
        throw new ApprovalError("This import has leads in an export batch, so it cannot be deleted.");
      }
    }

    const { hash, estimate } = await describeSubject(tx, input.subjectType, input.subjectId);
    await tx.query(
      `UPDATE approvals SET status = 'void', decision_note = 'Replaced by a newer request.'
       WHERE subject_type = $1 AND subject_id = $2 AND status = 'pending'`,
      [input.subjectType, input.subjectId],
    );
    const row = await one<{ id: number }>(
      tx,
      `INSERT INTO approvals (action_type, subject_type, subject_id, status, snapshot_hash, estimate_json, note, requested_by)
       VALUES ($1, $2, $3, 'pending', $4, $5::jsonb, $6, $7) RETURNING id`,
      [
        ACTION_FOR[input.subjectType],
        input.subjectType,
        input.subjectId,
        hash,
        JSON.stringify(estimate),
        input.note?.trim() || null,
        input.user.id,
      ],
    );
    if (input.subjectType === "export_batch") {
      await tx.query("UPDATE export_batches SET status = 'awaiting_approval', requested_by = $2 WHERE id = $1", [
        input.subjectId,
        input.user.id,
      ]);
    }
    await logAudit(tx, input.user, "approval.requested", `${input.subjectType}:${input.subjectId}`, {
      approvalId: row!.id,
      action: ACTION_FOR[input.subjectType],
      estimate,
    });
    return { approvalId: row!.id };
  });
}

type PendingApproval = {
  id: number;
  action_type: ActionType;
  subject_type: SubjectType;
  subject_id: number;
  status: string;
  snapshot_hash: string;
  requested_by: number;
};

// A person approving or rejecting a request. This is only ever called from a signed-in user's
// own click; there is no API key, webhook or job that reaches it.
export async function decideApproval(
  db: Db,
  config: Pick<Config, "requireSecondApprover">,
  input: { user: User; approvalId: number; approve: boolean; note?: string | null },
): Promise<{ outcome: "approved" | "rejected" | "void"; message: string }> {
  // TODO (briefing question 12): confirm who may approve. Until then: admins only.
  if (input.user.role !== "admin") throw new ApprovalError("Only an admin can approve or reject.");

  const outcome = await db.tx(async (tx) => {
    const approval = await one<PendingApproval>(tx, "SELECT * FROM approvals WHERE id = $1", [input.approvalId]);
    if (!approval) throw new ApprovalError("That request does not exist.");
    if (approval.status !== "pending") throw new ApprovalError("That request has already been decided.");

    const approver = await one<{ active: boolean; role: string }>(tx, "SELECT active, role FROM users WHERE id = $1", [
      input.user.id,
    ]);
    if (!approver?.active || approver.role !== "admin") throw new ApprovalError("Only an active admin can approve or reject.");

    const subject = `${approval.subject_type}:${approval.subject_id}`;
    const note = input.note?.trim() || null;

    if (!input.approve) {
      await tx.query(
        "UPDATE approvals SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1",
        [approval.id, input.user.id, note],
      );
      if (approval.subject_type === "export_batch") {
        await tx.query("UPDATE export_batches SET status = 'draft', requested_by = NULL WHERE id = $1", [approval.subject_id]);
      }
      await logAudit(tx, input.user, "approval.rejected", subject, { approvalId: approval.id, note });
      return { outcome: "rejected" as const, message: "Request rejected. Nothing was changed." };
    }

    if (config.requireSecondApprover && approval.requested_by === input.user.id) {
      throw new ApprovalError("You asked for this, so someone else has to approve it.");
    }

    // The subject is looked at again now. If it is not what was requested, the request is dead.
    let current: { hash: string } | null = null;
    try {
      current = await describeSubject(tx, approval.subject_type, approval.subject_id);
    } catch {
      current = null;
    }
    if (!current || current.hash !== approval.snapshot_hash) {
      await tx.query(
        `UPDATE approvals SET status = 'void', decided_by = $2, decided_at = now(),
                decision_note = 'It changed after the request was made.' WHERE id = $1`,
        [approval.id, input.user.id],
      );
      if (approval.subject_type === "export_batch" && current) {
        await tx.query("UPDATE export_batches SET status = 'draft', requested_by = NULL WHERE id = $1", [approval.subject_id]);
      }
      await logAudit(tx, input.user, "approval.void", subject, { approvalId: approval.id });
      return {
        outcome: "void" as const,
        message: "This changed after approval was requested, so the request was cancelled. Nothing was done. Ask again.",
      };
    }

    if (approval.subject_type === "export_batch") {
      const check = await checkBatch(tx, approval.subject_id);
      if (check.ineligible.length > 0) {
        throw new ApprovalError(
          `${check.ineligible.length} lead(s) in the batch can no longer be exported. They must be removed before this can be approved.`,
        );
      }
    }

    await tx.query(
      `UPDATE approvals SET status = 'approved', approved_by = $2, approved_at = now(),
              decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`,
      [approval.id, input.user.id, note],
    );
    await logAudit(tx, input.user, "approval.approved", subject, { approvalId: approval.id, note });

    if (approval.subject_type === "export_batch") {
      await tx.query("UPDATE export_batches SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1", [
        approval.subject_id,
        input.user.id,
      ]);
      return { outcome: "approved" as const, message: "Batch approved. The file can now be downloaded." };
    }

    // Deletes run straight away, and still go through the same gate check as everything else.
    await assertApproved(tx, config, {
      actionType: "delete",
      subjectType: approval.subject_type,
      subjectId: approval.subject_id,
      snapshotHash: current.hash,
    });
    if (approval.subject_type === "run") {
      const info = await executeRunDelete(tx, approval.subject_id, input.user);
      await tx.query("UPDATE approvals SET status = 'used' WHERE id = $1", [approval.id]);
      return { outcome: "approved" as const, message: `Import deleted: ${info.leads} lead(s) and ${info.rawRecords} raw row(s) removed.` };
    }
    const info = await executeDncListDelete(tx, approval.subject_id, input.user);
    await tx.query("UPDATE approvals SET status = 'used' WHERE id = $1", [approval.id]);
    return { outcome: "approved" as const, message: `DNC list "${info.name}" deleted: ${info.numbers} number(s) removed.` };
  });

  return outcome;
}

export type ApprovalListItem = {
  id: number;
  action_type: ActionType;
  subject_type: SubjectType;
  subject_id: number;
  status: string;
  estimate_json: Record<string, unknown>;
  note: string | null;
  decision_note: string | null;
  requested_by: number;
  requested_at: Date;
  decided_at: Date | null;
  requester_name: string;
  decider_name: string | null;
};

export async function listApprovals(db: Db, limit = 100): Promise<ApprovalListItem[]> {
  return await many<ApprovalListItem>(
    db,
    `SELECT a.id, a.action_type, a.subject_type, a.subject_id, a.status, a.estimate_json, a.note, a.decision_note,
            a.requested_by, a.requested_at, a.decided_at, r.name AS requester_name, d.name AS decider_name
     FROM approvals a
     JOIN users r ON r.id = a.requested_by
     LEFT JOIN users d ON d.id = a.decided_by
     ORDER BY (a.status = 'pending') DESC, a.id DESC LIMIT $1`,
    [limit],
  );
}

export { GateError };

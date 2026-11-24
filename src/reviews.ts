import { logAudit } from "./audit.js";
import { many, one, type Db } from "./db/db.js";
import { phonesOnDnc } from "./pipeline/dnc.js";

export class ReviewError extends Error {}

export type Decision = "approve" | "reject" | "needs_info";
type User = { id: number; email: string };

// Which statuses a decision may be applied from, and where it leaves the lead.
const RULES: Record<Decision, { from: string[]; to: string | null }> = {
  approve: { from: ["in_review", "rejected"], to: "approved" },
  reject: { from: ["in_review", "approved"], to: "rejected" },
  needs_info: { from: ["in_review"], to: null },
};

export async function decideLeads(
  db: Db,
  input: { user: User; leadIds: number[]; decision: Decision; reason: string | null },
): Promise<{ changed: number; skipped: number }> {
  const reason = input.reason?.replace(/\s+/g, " ").trim() || null;
  if (input.decision !== "approve" && !reason) {
    throw new ReviewError(input.decision === "reject" ? "Give a reason for rejecting." : "Say what information is missing.");
  }
  const leadIds = [...new Set(input.leadIds)].filter((id) => Number.isInteger(id));
  if (leadIds.length === 0) throw new ReviewError("Select at least one lead.");
  const rule = RULES[input.decision];

  return await db.tx(async (tx) => {
    const eligible = await many<{ id: number }>(
      tx,
      `SELECT id FROM leads
       WHERE id IN (SELECT (jsonb_array_elements_text($1::jsonb))::int)
         AND status IN (SELECT jsonb_array_elements_text($2::jsonb))
       ORDER BY id FOR UPDATE`,
      [JSON.stringify(leadIds), JSON.stringify(rule.from)],
    );
    const ids = eligible.map((row) => row.id);
    if (ids.length > 0) {
      const payload = JSON.stringify(ids);
      if (rule.to) {
        await tx.query(
          `UPDATE leads SET status = $2, status_reason = $3, updated_at = now()
           WHERE id IN (SELECT (jsonb_array_elements_text($1::jsonb))::int)`,
          [payload, rule.to, input.decision === "reject" ? reason : null],
        );
      }
      await tx.query(
        `INSERT INTO audit_decisions (lead_id, reviewer_user_id, decision, reason)
         SELECT value::int, $2, $3, $4 FROM jsonb_array_elements_text($1::jsonb)`,
        [payload, input.user.id, input.decision, reason],
      );
      await logAudit(tx, input.user, `review.${input.decision}`, null, { leads: ids, reason });
    }
    return { changed: ids.length, skipped: leadIds.length - ids.length };
  });
}

// A reviewer overruling the duplicate check for one lead. The lead goes to review, unless its
// number is on a DNC list right now, in which case it is blocked instead.
export async function markNotDuplicate(
  db: Db,
  input: { user: User; leadId: number; reason: string | null },
): Promise<"in_review" | "blocked_dnc"> {
  const reason = input.reason?.replace(/\s+/g, " ").trim() || null;
  if (!reason) throw new ReviewError("Say why this is not a duplicate.");

  return await db.tx(async (tx) => {
    const lead = await one<{ id: number; status: string; phone_e164: string | null }>(
      tx,
      "SELECT id, status, phone_e164 FROM leads WHERE id = $1 FOR UPDATE",
      [input.leadId],
    );
    if (!lead) throw new ReviewError("That lead does not exist.");
    if (lead.status !== "duplicate") throw new ReviewError("This lead is not marked as a duplicate.");

    const list = lead.phone_e164 ? (await phonesOnDnc(tx, [lead.phone_e164])).get(lead.phone_e164) : undefined;
    const status = list ? "blocked_dnc" : "in_review";
    await tx.query("UPDATE leads SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1", [
      lead.id,
      status,
      list ? `Phone is on the DNC list "${list}"` : null,
    ]);
    await tx.query(
      "INSERT INTO audit_decisions (lead_id, reviewer_user_id, decision, reason) VALUES ($1, $2, 'not_duplicate', $3)",
      [lead.id, input.user.id, reason],
    );
    await logAudit(tx, input.user, "review.not_duplicate", `lead:${lead.id}`, { reason, status });
    return status;
  });
}

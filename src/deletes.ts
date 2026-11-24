import { logAudit } from "./audit.js";
import { many, one, type Db } from "./db/db.js";

export class DeleteError extends Error {}

type User = { id: number; email: string };

export type RunDeleteInfo = {
  kind: "run";
  runId: number;
  source: string;
  fileName: string | null;
  leads: number;
  rawRecords: number;
  // Leads of this run that sit in an export batch. Any at all blocks the delete.
  inExportBatches: number;
  // Leads from other imports marked as duplicates of leads in this run. They go back to review.
  duplicatesPointingHere: number;
  canBeUndone: false;
};

export async function describeRunDelete(db: Db, runId: number): Promise<RunDeleteInfo> {
  const row = await one<{
    source: string;
    file_name: string | null;
    leads: number;
    raws: number;
    in_batches: number;
    dependents: number;
  }>(
    db,
    `SELECT s.name AS source, r.file_name,
       (SELECT count(*)::int FROM leads l WHERE l.run_id = r.id) AS leads,
       (SELECT count(*)::int FROM raw_records w WHERE w.run_id = r.id) AS raws,
       (SELECT count(DISTINCT b.lead_id)::int FROM export_batch_leads b JOIN leads l ON l.id = b.lead_id WHERE l.run_id = r.id) AS in_batches,
       (SELECT count(DISTINCT d.id)::int FROM dedupe_matches m
          JOIN leads o ON o.id = m.matched_lead_id AND o.run_id = r.id
          JOIN leads d ON d.id = m.lead_id AND d.run_id <> r.id AND d.status = 'duplicate') AS dependents
     FROM runs r JOIN sources s ON s.id = r.source_id WHERE r.id = $1`,
    [runId],
  );
  if (!row) throw new DeleteError("That import does not exist.");
  return {
    kind: "run",
    runId,
    source: row.source,
    fileName: row.file_name,
    leads: row.leads,
    rawRecords: row.raws,
    inExportBatches: row.in_batches,
    duplicatesPointingHere: row.dependents,
    canBeUndone: false,
  };
}

// Deletes an import with its raw rows and leads. Callers must have passed the delete gate.
export async function executeRunDelete(db: Db, runId: number, user: User): Promise<RunDeleteInfo> {
  return await db.tx(async (tx) => {
    const info = await describeRunDelete(tx, runId);
    if (info.inExportBatches > 0) {
      throw new DeleteError(
        `${info.inExportBatches} lead(s) from this import are in an export batch. An import with exported or batched leads cannot be deleted.`,
      );
    }

    // Leads elsewhere that were only duplicates because of this import must not be left pointing
    // at nothing. Per original, the earliest of them returns to review and the rest point at it.
    const dependents = await many<{ lead_id: number; matched_lead_id: number; rule_used: string }>(
      tx,
      `SELECT m.lead_id, m.matched_lead_id, m.rule_used FROM dedupe_matches m
       JOIN leads o ON o.id = m.matched_lead_id AND o.run_id = $1
       JOIN leads d ON d.id = m.lead_id AND d.run_id <> $1 AND d.status = 'duplicate'
       WHERE m.match_type = 'internal' ORDER BY m.lead_id`,
      [runId],
    );

    await tx.query("DELETE FROM runs WHERE id = $1", [runId]);

    const heirs = new Map<string, number>();
    for (const dependent of dependents) {
      const group = `${dependent.matched_lead_id}:${dependent.rule_used}`;
      const heir = heirs.get(group);
      const other = await one<{ id: number }>(
        tx,
        "SELECT id FROM dedupe_matches WHERE lead_id = $1 AND match_type = 'internal' LIMIT 1",
        [dependent.lead_id],
      );
      if (other) continue; // still a duplicate of some other lead
      if (heir === undefined) {
        heirs.set(group, dependent.lead_id);
        await tx.query(
          "UPDATE leads SET status = 'in_review', status_reason = NULL, updated_at = now() WHERE id = $1",
          [dependent.lead_id],
        );
      } else {
        await tx.query(
          `INSERT INTO dedupe_matches (lead_id, match_type, matched_ref, matched_lead_id, rule_used)
           VALUES ($1, 'internal', $2, $3, $4)`,
          [dependent.lead_id, `lead:${heir}`, heir, dependent.rule_used],
        );
        await tx.query("UPDATE leads SET status_reason = $2, updated_at = now() WHERE id = $1", [
          dependent.lead_id,
          `Duplicate of lead #${heir}`,
        ]);
      }
    }

    await logAudit(tx, user, "delete.run_deleted", `run:${runId}`, { ...info, returnedToReview: heirs.size });
    return info;
  });
}

export type DncListDeleteInfo = {
  kind: "dnc_list";
  listId: number;
  name: string;
  numbers: number;
  // Leads blocked only because of this list. They stop being blocked when it is deleted.
  leadsUnblocked: number;
  canBeUndone: false;
};

export async function describeDncListDelete(db: Db, listId: number): Promise<DncListDeleteInfo> {
  const row = await one<{ name: string; numbers: number; unblocked: number }>(
    db,
    `SELECT d.name,
       (SELECT count(*)::int FROM dnc_numbers n WHERE n.list_id = d.id) AS numbers,
       (SELECT count(*)::int FROM leads l
          WHERE l.status = 'blocked_dnc'
            AND EXISTS (SELECT 1 FROM dnc_numbers n WHERE n.phone_e164 = l.phone_e164 AND n.list_id = d.id)
            AND NOT EXISTS (SELECT 1 FROM dnc_numbers n WHERE n.phone_e164 = l.phone_e164 AND n.list_id <> d.id)) AS unblocked
     FROM dnc_lists d WHERE d.id = $1`,
    [listId],
  );
  if (!row) throw new DeleteError("That DNC list does not exist.");
  return { kind: "dnc_list", listId, name: row.name, numbers: row.numbers, leadsUnblocked: row.unblocked, canBeUndone: false };
}

export async function executeDncListDelete(db: Db, listId: number, user: User): Promise<DncListDeleteInfo> {
  return await db.tx(async (tx) => {
    const info = await describeDncListDelete(tx, listId);
    await tx.query("DELETE FROM dnc_lists WHERE id = $1", [listId]);
    await tx.query("DELETE FROM dedupe_matches WHERE match_type = 'dnc' AND matched_ref = $1", [`dnc_list:${listId}`]);

    // Leads no longer on any list go back to where they would have been without the block.
    await tx.query(
      `UPDATE leads l SET updated_at = now(),
         status = CASE WHEN EXISTS (SELECT 1 FROM dedupe_matches m WHERE m.lead_id = l.id AND m.match_type = 'internal')
                       THEN 'duplicate' ELSE 'in_review' END,
         status_reason = (SELECT 'Duplicate of lead #' || m.matched_lead_id FROM dedupe_matches m
                          WHERE m.lead_id = l.id AND m.match_type = 'internal' ORDER BY m.id LIMIT 1)
       WHERE l.status = 'blocked_dnc'
         AND NOT EXISTS (SELECT 1 FROM dnc_numbers n WHERE n.phone_e164 = l.phone_e164)`,
    );
    // With no list left, nothing counts as scrubbed any more.
    await tx.query(
      `UPDATE leads SET dnc_checked_at = NULL
       WHERE dnc_checked_at IS NOT NULL AND status <> 'exported' AND NOT EXISTS (SELECT 1 FROM dnc_lists)`,
    );

    await logAudit(tx, user, "delete.dnc_list_deleted", `dnc_list:${listId}`, info);
    return info;
  });
}

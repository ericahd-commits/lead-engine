import { stringify } from "csv-stringify/sync";
import { logAudit } from "./audit.js";
import type { Config } from "./config.js";
import { many, one, type Db } from "./db/db.js";
import { assertApproved, snapshotHash } from "./gate.js";
import { getDncState, phonesOnDnc } from "./pipeline/dnc.js";
import { splitPhone } from "./pipeline/normalize.js";

export class ExportError extends Error {}

type User = { id: number; email: string };

export type BatchRow = {
  id: number;
  name: string;
  target: string;
  target_ref: string | null;
  status: "draft" | "awaiting_approval" | "approved" | "running" | "done" | "failed";
  created_by: number;
  requested_by: number | null;
  approved_by: number | null;
  approved_at: Date | null;
  result_json: Record<string, unknown> | null;
  created_at: Date;
};

export type BatchLead = {
  id: number;
  business_name: string | null;
  phone_e164: string | null;
  website: string | null;
  website_domain: string | null;
  email: string | null;
  owner_name: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  category: string | null;
  status: string;
  dnc_checked_at: Date | null;
  source_name: string;
};

export async function getBatch(db: Db, batchId: number): Promise<BatchRow> {
  const batch = await one<BatchRow>(db, "SELECT * FROM export_batches WHERE id = $1", [batchId]);
  if (!batch) throw new ExportError("That export batch does not exist.");
  return batch;
}

export async function getBatchLeads(db: Db, batchId: number): Promise<BatchLead[]> {
  return await many<BatchLead>(
    db,
    `SELECT l.id, l.business_name, l.phone_e164, l.website, l.website_domain, l.email, l.owner_name, l.address,
            l.city, l.region, l.postal_code, l.country, l.category, l.status, l.dnc_checked_at, s.name AS source_name
     FROM export_batch_leads b
     JOIN leads l ON l.id = b.lead_id
     JOIN runs r ON r.id = l.run_id
     JOIN sources s ON s.id = r.source_id
     WHERE b.batch_id = $1 ORDER BY l.id`,
    [batchId],
  );
}

// Puts every approved lead that is not already in another batch into a new draft batch.
export async function createBatch(
  db: Db,
  input: { user: User; name: string; targetRef: string | null; runId: number | null },
): Promise<{ batchId: number; leadCount: number }> {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) throw new ExportError("Give the batch a name.");

  return await db.tx(async (tx) => {
    const batch = await one<{ id: number }>(
      tx,
      `INSERT INTO export_batches (name, target, target_ref, status, created_by)
       VALUES ($1, 'csv', $2, 'draft', $3) RETURNING id`,
      [name, input.targetRef?.trim() || null, input.user.id],
    );
    const batchId = batch!.id;
    const added = await many<{ lead_id: number }>(
      tx,
      `INSERT INTO export_batch_leads (batch_id, lead_id)
       SELECT $1, l.id FROM leads l
       WHERE l.status = 'approved'
         AND ($2::int IS NULL OR l.run_id = $2::int)
         AND NOT EXISTS (
           SELECT 1 FROM export_batch_leads b JOIN export_batches e ON e.id = b.batch_id
           WHERE b.lead_id = l.id AND e.status <> 'failed')
       RETURNING lead_id`,
      [batchId, input.runId],
    );
    if (added.length === 0) {
      throw new ExportError("There are no approved leads waiting to be exported.");
    }
    await logAudit(tx, input.user, "export.batch_created", `export_batch:${batchId}`, { name, leads: added.length });
    return { batchId, leadCount: added.length };
  });
}

// The exact content an approval covers: which leads, their dial number and name, and where the
// batch is going. Any change to these gives a different hash and the approval stops applying.
export async function batchSnapshot(db: Db, batchId: number): Promise<string> {
  const batch = await getBatch(db, batchId);
  const leads = await getBatchLeads(db, batchId);
  return snapshotHash({
    batch: batchId,
    target: batch.target,
    targetRef: batch.target_ref,
    leads: leads.map((lead) => [lead.id, lead.phone_e164, lead.business_name]),
  });
}

export type BatchCheck = {
  leadCount: number;
  ineligible: { leadId: number; name: string | null; reason: string }[];
  // True when no DNC list is loaded. The batch has then not been scrubbed at all.
  dncNeverLoaded: boolean;
  dncLists: number;
};

// Looks at the batch as it is this minute: a lead must still be approved and its number must not
// be on any DNC list loaded now, whatever was true when it was reviewed.
export async function checkBatch(db: Db, batchId: number): Promise<BatchCheck> {
  const batch = await getBatch(db, batchId);
  const leads = await getBatchLeads(db, batchId);
  const dnc = await getDncState(db);
  const ineligible: BatchCheck["ineligible"] = [];

  if (batch.status !== "done") {
    const onDnc = await phonesOnDnc(db, leads.map((lead) => lead.phone_e164 ?? ""));
    for (const lead of leads) {
      const list = lead.phone_e164 ? onDnc.get(lead.phone_e164) : undefined;
      if (list) {
        ineligible.push({ leadId: lead.id, name: lead.business_name, reason: `Phone is on the DNC list "${list}"` });
      } else if (lead.status !== "approved") {
        ineligible.push({ leadId: lead.id, name: lead.business_name, reason: `Lead is now "${lead.status}", not approved` });
      }
    }
  }

  return { leadCount: leads.length, ineligible, dncNeverLoaded: dnc.listCount === 0, dncLists: dnc.listCount };
}

// Any change to a batch cancels approvals that were given for its earlier content.
async function resetApproval(db: Db, batchId: number): Promise<void> {
  await db.query(
    `UPDATE approvals SET status = 'void', decision_note = 'The batch changed after this was requested.'
     WHERE subject_type = 'export_batch' AND subject_id = $1 AND status IN ('pending', 'approved')`,
    [batchId],
  );
  await db.query(
    `UPDATE export_batches SET status = 'draft', requested_by = NULL, approved_by = NULL, approved_at = NULL
     WHERE id = $1`,
    [batchId],
  );
}

export async function removeLeadsFromBatch(
  db: Db,
  input: { user: User; batchId: number; leadIds: number[] | "ineligible" },
): Promise<number> {
  return await db.tx(async (tx) => {
    const batch = await getBatch(tx, input.batchId);
    if (batch.status === "done" || batch.status === "running") {
      throw new ExportError("This batch has already been exported and can no longer be changed.");
    }
    const leadIds =
      input.leadIds === "ineligible"
        ? (await checkBatch(tx, input.batchId)).ineligible.map((item) => item.leadId)
        : input.leadIds;
    if (leadIds.length === 0) return 0;

    const removed = await many<{ lead_id: number }>(
      tx,
      `DELETE FROM export_batch_leads WHERE batch_id = $1
         AND lead_id IN (SELECT (jsonb_array_elements_text($2::jsonb))::int) RETURNING lead_id`,
      [input.batchId, JSON.stringify(leadIds)],
    );
    if (removed.length > 0) {
      await resetApproval(tx, input.batchId);
      await logAudit(tx, input.user, "export.leads_removed", `export_batch:${input.batchId}`, {
        removed: removed.map((row) => row.lead_id),
        approvalReset: batch.status !== "draft",
      });
    }
    return removed.length;
  });
}

const HEADERS = [
  "lead_id",
  "business_name",
  "phone_e164",
  "phone_code",
  "phone_number",
  "owner_name",
  "email",
  "website",
  "address",
  "city",
  "region",
  "postal_code",
  "country",
  "category",
  "source",
];

// Scraped text that starts with = + - @ would run as a formula when the file is opened in a
// spreadsheet. A leading apostrophe makes it plain text. Phone columns are digits we produced.
function safeCell(value: string | null): string {
  if (!value) return "";
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

// The row each lead came from, as it was in the imported file, with that file's column order.
export type Originals = Map<number, { headers: string[]; row: Record<string, string> }>;

export async function getBatchOriginals(db: Db, batchId: number): Promise<Originals> {
  const rows = await many<{ id: number; headers: string[] | null; row: Record<string, string> }>(
    db,
    `SELECT l.id, r.params_json->'headers' AS headers, w.payload_json AS row
     FROM export_batch_leads b
     JOIN leads l ON l.id = b.lead_id
     JOIN runs r ON r.id = l.run_id
     JOIN raw_records w ON w.id = l.source_record_id
     WHERE b.batch_id = $1`,
    [batchId],
  );
  return new Map(rows.map((item) => [item.id, { headers: item.headers ?? Object.keys(item.row), row: item.row }]));
}

// Original values are scraped text too, so they get the same formula guard. A value made only
// of phone characters (such as +1 714 951 0945) is left alone.
function safeOriginal(value: string | undefined): string {
  if (!value) return "";
  return /^[+\-]?[\d\s().\-]+$/.test(value) ? value : safeCell(value);
}

// The app's own columns first, then every column of the imported files, under its original name.
// A batch can hold leads from files with different columns: a lead has blanks for columns its
// file did not have.
export function batchCsv(leads: BatchLead[], originals: Originals = new Map()): string {
  const extra: string[] = [];
  for (const lead of leads) {
    for (const header of originals.get(lead.id)?.headers ?? []) if (!extra.includes(header)) extra.push(header);
  }
  const extraNames = extra.map((header) => (HEADERS.includes(header) ? `original_${header}` : header));

  const rows = leads.map((lead) => {
    const phone = splitPhone(lead.phone_e164);
    const original = originals.get(lead.id)?.row ?? {};
    return [
      String(lead.id),
      safeCell(lead.business_name),
      lead.phone_e164 ?? "",
      phone?.callingCode ?? "",
      phone?.national ?? "",
      safeCell(lead.owner_name),
      safeCell(lead.email),
      safeCell(lead.website),
      safeCell(lead.address),
      safeCell(lead.city),
      safeCell(lead.region),
      safeCell(lead.postal_code),
      safeCell(lead.country),
      safeCell(lead.category),
      safeCell(lead.source_name),
      ...extra.map((header) => safeOriginal(original[header])),
    ];
  });
  return stringify([[...HEADERS, ...extraNames], ...rows]);
}

// Produces the export file. This is the gated action: it runs only with a human approval that
// still matches the batch, and only if every lead passes the live check.
export async function downloadBatch(
  db: Db,
  config: Pick<Config, "requireSecondApprover">,
  input: { user: User; batchId: number },
): Promise<{ fileName: string; csv: string }> {
  return await db.tx(async (tx) => {
    const batch = await getBatch(tx, input.batchId);
    if (batch.status !== "approved" && batch.status !== "done") {
      throw new ExportError("This batch has not been approved yet.");
    }
    const approval = await assertApproved(tx, config, {
      actionType: "import",
      subjectType: "export_batch",
      subjectId: batch.id,
      snapshotHash: await batchSnapshot(tx, batch.id),
      allowUsed: batch.status === "done",
    });

    const check = await checkBatch(tx, batch.id);
    if (check.ineligible.length > 0) {
      throw new ExportError(
        `${check.ineligible.length} lead(s) in this batch can no longer be exported. Remove them and ask for approval again.`,
      );
    }

    const leads = await getBatchLeads(tx, batch.id);
    const csv = batchCsv(leads, await getBatchOriginals(tx, batch.id));
    const firstDownload = batch.status === "approved";

    if (firstDownload) {
      await tx.query(
        `UPDATE leads SET status = 'exported', updated_at = now()
         WHERE id IN (SELECT lead_id FROM export_batch_leads WHERE batch_id = $1)`,
        [batch.id],
      );
      await tx.query("UPDATE approvals SET status = 'used' WHERE id = $1", [approval.id]);
      await tx.query("UPDATE export_batches SET status = 'done', result_json = $2::jsonb WHERE id = $1", [
        batch.id,
        JSON.stringify({
          leads: leads.length,
          exportedAt: new Date().toISOString(),
          exportedBy: input.user.email,
          dncListsAtExport: check.dncLists,
        }),
      ]);
    }
    await logAudit(tx, input.user, firstDownload ? "export.downloaded" : "export.downloaded_again", `export_batch:${batch.id}`, {
      leads: leads.length,
      approvalId: approval.id,
      dncListsAtExport: check.dncLists,
    });

    const slug = batch.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "batch";
    return { fileName: `lead-engine-${batch.id}-${slug}.csv`, csv };
  });
}

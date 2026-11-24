import { parse } from "csv-parse/sync";
import { logAudit } from "../audit.js";
import { many, one, type Db } from "../db/db.js";
import { normalizePhone } from "./normalize.js";

export class DncError extends Error {}

export type DncState = { listCount: number; numberCount: number };

export async function getDncState(db: Db): Promise<DncState> {
  const row = await one<{ lists: number; numbers: number }>(
    db,
    `SELECT (SELECT count(*)::int FROM dnc_lists) AS lists,
            (SELECT count(DISTINCT phone_e164)::int FROM dnc_numbers) AS numbers`,
  );
  return { listCount: row?.lists ?? 0, numberCount: row?.numbers ?? 0 };
}

// Every valid phone number found anywhere in the file, plus the lines that held none.
export function extractDncNumbers(text: string, defaultCountry: string): { numbers: string[]; unreadable: string[]; rows: number } {
  const body = text.replace(/^﻿/, "");
  let records: string[][];
  try {
    records = parse(body, { relax_column_count: true, relax_quotes: true, skip_empty_lines: true }) as string[][];
  } catch (error) {
    throw new DncError(`The file could not be read: ${(error as Error).message}`);
  }

  const numbers = new Set<string>();
  const unreadable: string[] = [];
  let rows = 0;
  records.forEach((record, index) => {
    const cells = record.map((cell) => cell.trim()).filter(Boolean);
    if (cells.length === 0) return;
    const found = cells.map((cell) => normalizePhone(cell, defaultCountry)).filter((value): value is string => Boolean(value));
    if (found.length === 0) {
      // A first line with no digits at all is a header, not a bad number.
      if (index === 0 && !/\d{6,}/.test(cells.join(""))) return;
      rows += 1;
      unreadable.push(cells.join(", ").slice(0, 80));
      return;
    }
    rows += 1;
    for (const number of found) numbers.add(number);
  });

  return { numbers: [...numbers], unreadable, rows };
}

export type DncUploadResult = {
  listId: number;
  rows: number;
  numbers: number;
  unreadable: string[];
  recheck: DncRecheckResult;
};

export async function uploadDncList(
  db: Db,
  input: { user: { id: number; email: string }; name: string; fileName: string; text: string; defaultCountry: string },
): Promise<DncUploadResult> {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) throw new DncError("Give the list a name that says where it came from, for example \"Internal DNC, Nov 2026\".");
  const extracted = extractDncNumbers(input.text, input.defaultCountry);
  if (extracted.numbers.length === 0) throw new DncError("No valid phone numbers were found in that file.");

  return await db.tx(async (tx) => {
    const list = await one<{ id: number }>(
      tx,
      "INSERT INTO dnc_lists (name, file_name, number_count, uploaded_by) VALUES ($1, $2, $3, $4) RETURNING id",
      [name, input.fileName, extracted.numbers.length, input.user.id],
    );
    const listId = list!.id;
    for (let index = 0; index < extracted.numbers.length; index += 5000) {
      await tx.query(
        `INSERT INTO dnc_numbers (phone_e164, list_id)
         SELECT value, $1 FROM jsonb_array_elements_text($2::jsonb) ON CONFLICT DO NOTHING`,
        [listId, JSON.stringify(extracted.numbers.slice(index, index + 5000))],
      );
    }
    await logAudit(tx, input.user, "dnc.list_uploaded", `dnc_list:${listId}`, {
      name,
      file: input.fileName,
      numbers: extracted.numbers.length,
      unreadableRows: extracted.unreadable.length,
    });
    const recheck = await recheckDnc(tx, input.user);
    return { listId, rows: extracted.rows, numbers: extracted.numbers.length, unreadable: extracted.unreadable, recheck };
  });
}

export type DncRecheckResult = { checked: number; newlyBlocked: number };

// Compares every lead that could still be exported with the DNC lists loaded right now.
// Exported leads are left alone: they have already left the app.
export async function recheckDnc(db: Db, user: { id: number; email: string }): Promise<DncRecheckResult> {
  const state = await getDncState(db);
  if (state.listCount === 0) return { checked: 0, newlyBlocked: 0 };

  return await db.tx(async (tx) => {
    const hits = await many<{ id: number; list_id: number; name: string }>(
      tx,
      `SELECT DISTINCT ON (l.id) l.id, n.list_id, d.name
       FROM leads l
       JOIN dnc_numbers n ON n.phone_e164 = l.phone_e164
       JOIN dnc_lists d ON d.id = n.list_id
       WHERE l.status IN ('in_review', 'approved', 'rejected', 'duplicate', 'in_vici', 'in_close')
       ORDER BY l.id, n.list_id`,
    );
    if (hits.length > 0) {
      const payload = JSON.stringify(
        hits.map((hit) => ({ id: hit.id, list_id: hit.list_id, reason: `Phone is on the DNC list "${hit.name}"` })),
      );
      await tx.query(
        `UPDATE leads SET status = 'blocked_dnc', status_reason = x.reason, updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS x(id int, reason text) WHERE leads.id = x.id`,
        [payload],
      );
      await tx.query(
        `INSERT INTO dedupe_matches (lead_id, match_type, matched_ref, rule_used)
         SELECT x.id, 'dnc', 'dnc_list:' || x.list_id, 'phone'
         FROM jsonb_to_recordset($1::jsonb) AS x(id int, list_id int)`,
        [payload],
      );
    }
    const checked = await one<{ count: number }>(
      tx,
      `WITH touched AS (
         UPDATE leads SET dnc_checked_at = now()
         WHERE phone_e164 IS NOT NULL AND status NOT IN ('exported', 'invalid') RETURNING 1
       ) SELECT count(*)::int AS count FROM touched`,
    );
    const result = { checked: checked?.count ?? 0, newlyBlocked: hits.length };
    await logAudit(tx, user, "dnc.rechecked", null, result);
    return result;
  });
}

// The DNC lists a set of phone numbers is on right now. Used at export time, so the answer never
// depends on when a lead was last checked.
export async function phonesOnDnc(db: Db, phones: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const unique = [...new Set(phones.filter(Boolean))];
  if (unique.length === 0) return found;
  const rows = await many<{ phone_e164: string; name: string }>(
    db,
    `SELECT DISTINCT ON (n.phone_e164) n.phone_e164, d.name
     FROM dnc_numbers n JOIN dnc_lists d ON d.id = n.list_id
     WHERE n.phone_e164 IN (SELECT jsonb_array_elements_text($1::jsonb))
     ORDER BY n.phone_e164, n.list_id`,
    [JSON.stringify(unique)],
  );
  for (const row of rows) found.set(row.phone_e164, row.name);
  return found;
}

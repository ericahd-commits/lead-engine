import { parse } from "csv-parse/sync";
import { logAudit } from "../audit.js";
import { many, one, type Db } from "../db/db.js";
import { pickDelimiter } from "./csv.js";
import { normalizePhone } from "./normalize.js";

// Records that already exist in VICIdial or Close, known to this app only through files exported
// from those systems and uploaded here. Matching is by phone number.

export class KnownError extends Error {}

export const KNOWN_KINDS = ["vici", "close"] as const;
export type KnownKind = (typeof KNOWN_KINDS)[number];
export const KNOWN_LABEL: Record<KnownKind, string> = { vici: "VICIdial", close: "Close" };
export const KNOWN_STATUS: Record<KnownKind, "in_vici" | "in_close"> = { vici: "in_vici", close: "in_close" };

type User = { id: number; email: string };

export type KnownState = Record<KnownKind, { lists: number; numbers: number; latest: Date | null }>;

export async function getKnownState(db: Db): Promise<KnownState> {
  const rows = await many<{ kind: KnownKind; lists: number; numbers: number; latest: Date | null }>(
    db,
    `SELECT k.kind, count(DISTINCT k.id)::int AS lists, count(DISTINCT n.phone_e164)::int AS numbers,
            max(k.uploaded_at) AS latest
     FROM known_lists k LEFT JOIN known_numbers n ON n.list_id = k.id GROUP BY k.kind`,
  );
  const state: KnownState = { vici: { lists: 0, numbers: 0, latest: null }, close: { lists: 0, numbers: 0, latest: null } };
  for (const row of rows) state[row.kind] = { lists: row.lists, numbers: row.numbers, latest: row.latest };
  return state;
}

const PHONE_HEADER = /phone|mobile|telephone|\bcell|\btel\b/i;

export type KnownExtract = {
  numbers: string[];
  rows: number;
  rowsWithoutNumber: number;
  // The header names the numbers were read from, or null when every column was scanned.
  columns: string[] | null;
};

// An export has many number-like columns (lead ids, list ids, vendor codes). When the file has a
// header row naming its phone columns, only those are read, so an id is never taken for a number.
export function extractKnownNumbers(text: string, defaultCountry: string): KnownExtract {
  const body = text.replace(/^﻿/, "");
  if (body.trim().length === 0) throw new KnownError("The file is empty.");
  if (body.slice(0, 4) === "PK\u0003\u0004") {
    throw new KnownError("This looks like an Excel file (.xlsx). Save it as CSV and upload that.");
  }
  let records: string[][];
  try {
    records = parse(body, {
      delimiter: pickDelimiter(body),
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
    }) as string[][];
  } catch (error) {
    throw new KnownError(`The file could not be read: ${(error as Error).message}`);
  }

  const first = (records[0] ?? []).map((cell) => cell.trim());
  const hasHeader =
    first.length > 0 && !/\d{6,}/.test(first.join(" ")) && !first.some((cell) => normalizePhone(cell, defaultCountry));
  const phoneIndexes = hasHeader ? first.flatMap((name, index) => (PHONE_HEADER.test(name) ? [index] : [])) : [];
  const columns = phoneIndexes.length > 0 ? phoneIndexes.map((index) => first[index]!) : null;

  const numbers = new Set<string>();
  let rows = 0;
  let rowsWithoutNumber = 0;
  for (const record of hasHeader ? records.slice(1) : records) {
    if (!record.some((cell) => cell.trim())) continue;
    rows += 1;
    const cells = columns ? phoneIndexes.map((index) => record[index] ?? "") : record;
    let found = false;
    for (const cell of cells) {
      const number = normalizePhone(cell.trim(), defaultCountry);
      if (number) {
        numbers.add(number);
        found = true;
      }
    }
    if (!found) rowsWithoutNumber += 1;
  }
  return { numbers: [...numbers], rows, rowsWithoutNumber, columns };
}

export type KnownUploadResult = KnownExtract & { listId: number; recheck: KnownRecheckResult };

export async function uploadKnownList(
  db: Db,
  input: { user: User; kind: string; name: string; fileName: string; text: string; defaultCountry: string },
): Promise<KnownUploadResult> {
  const kind = KNOWN_KINDS.find((value) => value === input.kind);
  if (!kind) throw new KnownError("Choose whether the file came from VICIdial or from Close.");
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) throw new KnownError('Give the file a name that says what it is, for example "VICIdial list 1048, 24 Nov".');
  const extracted = extractKnownNumbers(input.text, input.defaultCountry);
  if (extracted.numbers.length === 0) throw new KnownError("No valid phone numbers were found in that file.");

  return await db.tx(async (tx) => {
    const list = await one<{ id: number }>(
      tx,
      `INSERT INTO known_lists (kind, name, file_name, number_count, phone_columns, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [kind, name, input.fileName, extracted.numbers.length, extracted.columns?.join(", ") ?? null, input.user.id],
    );
    const listId = list!.id;
    for (let index = 0; index < extracted.numbers.length; index += 5000) {
      await tx.query(
        `INSERT INTO known_numbers (phone_e164, list_id)
         SELECT value, $1 FROM jsonb_array_elements_text($2::jsonb) ON CONFLICT DO NOTHING`,
        [listId, JSON.stringify(extracted.numbers.slice(index, index + 5000))],
      );
    }
    await logAudit(tx, input.user, "known.list_uploaded", `known_list:${listId}`, {
      system: KNOWN_LABEL[kind],
      name,
      file: input.fileName,
      numbers: extracted.numbers.length,
      rows: extracted.rows,
      rowsWithoutNumber: extracted.rowsWithoutNumber,
      columns: extracted.columns ?? "every column scanned",
    });
    const recheck = await recheckKnown(tx, input.user);
    return { ...extracted, listId, recheck };
  });
}

export function knownReason(kind: KnownKind, listName: string): string {
  return `Phone is already in ${KNOWN_LABEL[kind]}, per the file "${listName}"`;
}

export type KnownHit = { kind: KnownKind; listId: number; listName: string };

// Where a set of phone numbers already exists. A number in both systems is reported as Close:
// a CRM record says more about the business than a dial-list row does.
export async function phonesKnown(db: Db, phones: string[]): Promise<Map<string, KnownHit>> {
  const found = new Map<string, KnownHit>();
  const unique = [...new Set(phones.filter(Boolean))];
  if (unique.length === 0) return found;
  const rows = await many<{ phone_e164: string; kind: KnownKind; id: number; name: string }>(
    db,
    `SELECT DISTINCT ON (n.phone_e164) n.phone_e164, k.kind, k.id, k.name
     FROM known_numbers n JOIN known_lists k ON k.id = n.list_id
     WHERE n.phone_e164 IN (SELECT jsonb_array_elements_text($1::jsonb))
     ORDER BY n.phone_e164, (k.kind = 'close') DESC, k.id DESC`,
    [JSON.stringify(unique)],
  );
  for (const row of rows) found.set(row.phone_e164, { kind: row.kind, listId: row.id, listName: row.name });
  return found;
}

export type KnownRecheckResult = { newlyMarked: number };

// Compares every lead that could still reach an export with the files loaded right now.
// DNC-blocked, invalid and already exported leads are left as they are.
export async function recheckKnown(db: Db, user: User): Promise<KnownRecheckResult> {
  return await db.tx(async (tx) => {
    const hits = await many<{ id: number; kind: KnownKind; list_id: number; name: string }>(
      tx,
      `SELECT DISTINCT ON (l.id) l.id, k.kind, k.id AS list_id, k.name
       FROM leads l
       JOIN known_numbers n ON n.phone_e164 = l.phone_e164
       JOIN known_lists k ON k.id = n.list_id
       WHERE l.status IN ('in_review', 'approved', 'rejected', 'duplicate')
       ORDER BY l.id, (k.kind = 'close') DESC, k.id DESC`,
    );
    if (hits.length > 0) {
      const payload = JSON.stringify(
        hits.map((hit) => ({
          id: hit.id,
          status: KNOWN_STATUS[hit.kind],
          match_type: hit.kind,
          ref: `known_list:${hit.list_id}`,
          reason: knownReason(hit.kind, hit.name),
        })),
      );
      await tx.query(
        `UPDATE leads SET status = x.status, status_reason = x.reason, updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS x(id int, status text, reason text) WHERE leads.id = x.id`,
        [payload],
      );
      await tx.query(
        `INSERT INTO dedupe_matches (lead_id, match_type, matched_ref, rule_used)
         SELECT x.id, x.match_type, x.ref, 'phone'
         FROM jsonb_to_recordset($1::jsonb) AS x(id int, match_type text, ref text)`,
        [payload],
      );
    }
    const result = { newlyMarked: hits.length };
    await logAudit(tx, user, "known.rechecked", null, result);
    return result;
  });
}

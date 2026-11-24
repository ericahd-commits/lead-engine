import { logAudit, type Actor } from "../audit.js";
import { many, one, type Db } from "../db/db.js";
import { loadSettings, type DedupeKey, type Settings } from "../settings.js";
import { parseCsv } from "./csv.js";
import { cleanMapping, guessMapping, type ColumnMapping } from "./mapping.js";
import { cleanText, nameCityKey, normalizeDomain, normalizeEmail, normalizePhone } from "./normalize.js";

export class ImportError extends Error {}

export type RunSummary = {
  total: number;
  in_review: number;
  duplicate: number;
  blocked_dnc: number;
  invalid: number;
  // False when no DNC list was loaded at import time: nothing was scrubbed, which is not "clear".
  dncChecked: boolean;
  dedupeKeys: DedupeKey[];
  requiredFields: string[];
};

const CHUNK = 500;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export async function createImport(
  db: Db,
  input: { user: { id: number; email: string }; sourceName: string; fileName: string; text: string; maxRows: number },
): Promise<{ runId: number }> {
  const sourceName = input.sourceName.replace(/\s+/g, " ").trim();
  if (!sourceName) throw new ImportError("Give the source a name, for example the Octoparse task it came from.");
  const parsed = parseCsv(input.text, input.maxRows);

  return await db.tx(async (tx) => {
    let source = await one<{ id: number }>(tx, "SELECT id FROM sources WHERE lower(name) = lower($1)", [sourceName]);
    source ??= await one<{ id: number }>(
      tx,
      "INSERT INTO sources (kind, name) VALUES ('csv', $1) RETURNING id",
      [sourceName],
    );

    const run = await one<{ id: number }>(
      tx,
      `INSERT INTO runs (source_id, status, file_name, params_json, row_count, created_by)
       VALUES ($1, 'needs_mapping', $2, $3::jsonb, $4, $5) RETURNING id`,
      [source!.id, input.fileName, JSON.stringify({ headers: parsed.headers }), parsed.rows.length, input.user.id],
    );
    const runId = run!.id;

    const numbered = parsed.rows.map((payload, index) => ({ n: index + 1, p: payload }));
    for (const part of chunks(numbered, 1000)) {
      await tx.query(
        `INSERT INTO raw_records (run_id, row_number, payload_json)
         SELECT $1, x.n, x.p FROM jsonb_to_recordset($2::jsonb) AS x(n int, p jsonb)`,
        [runId, JSON.stringify(part)],
      );
    }

    await logAudit(tx, input.user, "import.uploaded", `run:${runId}`, {
      source: sourceName,
      file: input.fileName,
      rows: parsed.rows.length,
    });
    return { runId };
  });
}

export async function getSuggestedMapping(db: Db, runId: number): Promise<{ headers: string[]; mapping: ColumnMapping }> {
  const run = await one<{ params_json: { headers?: string[] }; config_json: { mapping?: Partial<ColumnMapping> } }>(
    db,
    `SELECT r.params_json, s.config_json FROM runs r JOIN sources s ON s.id = r.source_id WHERE r.id = $1`,
    [runId],
  );
  if (!run) throw new ImportError("That import does not exist.");
  const headers = run.params_json.headers ?? [];
  return { headers, mapping: guessMapping(headers, run.config_json.mapping) };
}

type Candidate = {
  rawId: number;
  business_name: string | null;
  phone_raw: string | null;
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
  name_key: string | null;
  status: "in_review" | "duplicate" | "blocked_dnc" | "invalid";
  status_reason: string | null;
  dncListId: number | null;
  // An earlier lead this one repeats: one already in the database, or an earlier row of this file.
  duplicateOf: { rule: DedupeKey; existingId?: number; rawId?: number } | null;
};

const FIELD_NAMES: Record<string, string> = {
  business_name: "business name",
  phone_e164: "phone",
  website_domain: "website",
  email: "email",
  address: "address",
  city: "city",
  region: "state / region",
  postal_code: "ZIP / postal code",
  category: "category",
};

function buildCandidate(rawId: number, payload: Record<string, string>, mapping: ColumnMapping, settings: Settings): Candidate {
  const cell = (field: keyof ColumnMapping) => (mapping[field] ? cleanText(payload[mapping[field]]) : null);

  const country = cell("country");
  const phoneCountry = country && /^[A-Za-z]{2}$/.test(country) ? country : settings.defaultCountry;
  const phoneRaw = cell("phone");
  const website = cell("website");
  const businessName = cell("business_name");
  const city = cell("city");
  const rawRegion = cell("region");
  const region = rawRegion && /^[A-Za-z]{2}$/.test(rawRegion) ? rawRegion.toUpperCase() : rawRegion;

  return {
    rawId,
    business_name: businessName,
    phone_raw: phoneRaw,
    phone_e164: normalizePhone(phoneRaw, phoneCountry),
    website,
    website_domain: normalizeDomain(website),
    email: normalizeEmail(cell("email")),
    owner_name: cell("owner_name"),
    address: cell("address"),
    city,
    region,
    postal_code: cell("postal_code"),
    country,
    category: cell("category"),
    name_key: nameCityKey(businessName, city, region),
    status: "in_review",
    status_reason: null,
    dncListId: null,
    duplicateOf: null,
  };
}

function missingRequired(candidate: Candidate, settings: Settings): string | null {
  const missing: string[] = [];
  for (const field of settings.requiredFields) {
    if (candidate[field]) continue;
    if (field === "phone_e164" && candidate.phone_raw) {
      missing.push(`phone ("${candidate.phone_raw}" is not a valid number)`);
    } else if (field === "website_domain" && candidate.website) {
      missing.push(`website ("${candidate.website}" is not a valid address)`);
    } else {
      missing.push(FIELD_NAMES[field] ?? field);
    }
  }
  return missing.length ? `Missing required: ${missing.join(", ")}` : null;
}

function dedupeValue(candidate: Candidate, key: DedupeKey, shared: Set<string>): string | null {
  if (key === "phone") return candidate.phone_e164;
  if (key === "domain") return candidate.website_domain && !shared.has(candidate.website_domain) ? candidate.website_domain : null;
  return candidate.name_key;
}

const KEY_COLUMN: Record<DedupeKey, string> = { phone: "phone_e164", domain: "website_domain", name_city: "name_key" };
const KEY_LABEL: Record<DedupeKey, string> = { phone: "phone", domain: "website", name_city: "name and city" };

export async function processImport(
  db: Db,
  input: { runId: number; mapping: Record<string, unknown>; user: { id: number; email: string } },
): Promise<RunSummary> {
  const run = await one<{ id: number; status: string; source_id: number; params_json: { headers?: string[] } }>(
    db,
    "SELECT id, status, source_id, params_json FROM runs WHERE id = $1",
    [input.runId],
  );
  if (!run) throw new ImportError("That import does not exist.");
  if (run.status !== "needs_mapping" && run.status !== "failed") {
    throw new ImportError("This import has already been processed.");
  }

  const mapping = cleanMapping(input.mapping, run.params_json.headers ?? []);
  if (!Object.values(mapping).some(Boolean)) {
    throw new ImportError("Match at least one column to a lead field before importing.");
  }

  try {
    return await db.tx(async (tx) => {
      const settings = await loadSettings(tx);
      const shared = new Set(settings.sharedDomains);
      await tx.query("UPDATE runs SET status = 'running', started_at = now(), error = NULL WHERE id = $1", [run.id]);
      await tx.query("DELETE FROM leads WHERE run_id = $1", [run.id]);

      const raws = await many<{ id: number; payload_json: Record<string, string> }>(
        tx,
        "SELECT id, payload_json FROM raw_records WHERE run_id = $1 ORDER BY row_number",
        [run.id],
      );
      const candidates = raws.map((raw) => buildCandidate(raw.id, raw.payload_json, mapping, settings));

      // Leads already in the database that share a key with this file.
      const existing = new Map<string, number>();
      for (const key of settings.dedupeKeys) {
        const values = [...new Set(candidates.map((candidate) => dedupeValue(candidate, key, shared)).filter(Boolean))];
        if (values.length === 0) continue;
        const column = KEY_COLUMN[key];
        const rows = await many<{ value: string; id: number }>(
          tx,
          `SELECT ${column} AS value, min(id)::int AS id FROM leads
           WHERE status NOT IN ('duplicate', 'invalid')
             AND ${column} IN (SELECT jsonb_array_elements_text($1::jsonb))
           GROUP BY ${column}`,
          [JSON.stringify(values)],
        );
        for (const row of rows) existing.set(`${key}:${row.value}`, row.id);
      }

      const phones = [...new Set(candidates.map((candidate) => candidate.phone_e164).filter(Boolean))];
      const dncHits = new Map<string, { listId: number; listName: string }>();
      const dncLists = await one<{ count: number }>(tx, "SELECT count(*)::int AS count FROM dnc_lists");
      const dncChecked = (dncLists?.count ?? 0) > 0;
      if (dncChecked && phones.length > 0) {
        const rows = await many<{ phone_e164: string; list_id: number; name: string }>(
          tx,
          `SELECT DISTINCT ON (n.phone_e164) n.phone_e164, n.list_id, l.name
           FROM dnc_numbers n JOIN dnc_lists l ON l.id = n.list_id
           WHERE n.phone_e164 IN (SELECT jsonb_array_elements_text($1::jsonb))
           ORDER BY n.phone_e164, n.list_id`,
          [JSON.stringify(phones)],
        );
        for (const row of rows) dncHits.set(row.phone_e164, { listId: row.list_id, listName: row.name });
      }

      const firstInFile = new Map<string, number>();
      for (const candidate of candidates) {
        const missing = missingRequired(candidate, settings);
        if (missing) {
          candidate.status = "invalid";
          candidate.status_reason = missing;
          continue;
        }

        for (const key of settings.dedupeKeys) {
          const value = dedupeValue(candidate, key, shared);
          if (!value) continue;
          const existingId = existing.get(`${key}:${value}`);
          const earlierRaw = firstInFile.get(`${key}:${value}`);
          if (existingId !== undefined) {
            candidate.duplicateOf = { rule: key, existingId };
            break;
          }
          if (earlierRaw !== undefined) {
            candidate.duplicateOf = { rule: key, rawId: earlierRaw };
            break;
          }
        }

        if (!candidate.duplicateOf) {
          for (const key of settings.dedupeKeys) {
            const value = dedupeValue(candidate, key, shared);
            if (value && !firstInFile.has(`${key}:${value}`)) firstInFile.set(`${key}:${value}`, candidate.rawId);
          }
        }

        const dnc = candidate.phone_e164 ? dncHits.get(candidate.phone_e164) : undefined;
        if (dnc) {
          candidate.status = "blocked_dnc";
          candidate.status_reason = `Phone is on the DNC list "${dnc.listName}"`;
          candidate.dncListId = dnc.listId;
        } else if (candidate.duplicateOf) {
          candidate.status = "duplicate";
        }
      }

      const leadIdByRaw = new Map<number, number>();
      for (const part of chunks(candidates, CHUNK)) {
        const rows = await many<{ id: number; source_record_id: number }>(
          tx,
          `INSERT INTO leads (run_id, source_record_id, business_name, phone_raw, phone_e164, website, website_domain,
                              email, owner_name, address, city, region, postal_code, country, category, name_key,
                              status, status_reason, dnc_checked_at)
           SELECT $1, x."rawId", x.business_name, x.phone_raw, x.phone_e164, x.website, x.website_domain,
                  x.email, x.owner_name, x.address, x.city, x.region, x.postal_code, x.country, x.category, x.name_key,
                  x.status, x.status_reason, CASE WHEN $3::boolean AND x.phone_e164 IS NOT NULL THEN now() END
           FROM jsonb_to_recordset($2::jsonb) AS x(
             "rawId" int, business_name text, phone_raw text, phone_e164 text, website text, website_domain text,
             email text, owner_name text, address text, city text, region text, postal_code text, country text,
             category text, name_key text, status text, status_reason text)
           RETURNING id, source_record_id`,
          [run.id, JSON.stringify(part), dncChecked],
        );
        for (const row of rows) leadIdByRaw.set(row.source_record_id, row.id);
      }

      const matches: { lead_id: number; match_type: string; matched_ref: string; matched_lead_id: number | null; rule_used: string }[] = [];
      const reasons: { id: number; reason: string }[] = [];
      for (const candidate of candidates) {
        const leadId = leadIdByRaw.get(candidate.rawId);
        if (leadId === undefined) continue;
        if (candidate.duplicateOf) {
          const matchedId = candidate.duplicateOf.existingId ?? leadIdByRaw.get(candidate.duplicateOf.rawId!) ?? null;
          if (matchedId !== null) {
            matches.push({
              lead_id: leadId,
              match_type: "internal",
              matched_ref: `lead:${matchedId}`,
              matched_lead_id: matchedId,
              rule_used: candidate.duplicateOf.rule,
            });
            if (candidate.status === "duplicate") {
              reasons.push({ id: leadId, reason: `Same ${KEY_LABEL[candidate.duplicateOf.rule]} as lead #${matchedId}` });
            }
          }
        }
        if (candidate.dncListId !== null) {
          matches.push({
            lead_id: leadId,
            match_type: "dnc",
            matched_ref: `dnc_list:${candidate.dncListId}`,
            matched_lead_id: null,
            rule_used: "phone",
          });
        }
      }
      for (const part of chunks(matches, 1000)) {
        await tx.query(
          `INSERT INTO dedupe_matches (lead_id, match_type, matched_ref, matched_lead_id, rule_used)
           SELECT x.lead_id, x.match_type, x.matched_ref, x.matched_lead_id, x.rule_used
           FROM jsonb_to_recordset($1::jsonb) AS x(lead_id int, match_type text, matched_ref text, matched_lead_id int, rule_used text)`,
          [JSON.stringify(part)],
        );
      }
      for (const part of chunks(reasons, 1000)) {
        await tx.query(
          `UPDATE leads SET status_reason = x.reason
           FROM jsonb_to_recordset($1::jsonb) AS x(id int, reason text) WHERE leads.id = x.id`,
          [JSON.stringify(part)],
        );
      }

      const summary: RunSummary = {
        total: candidates.length,
        in_review: 0,
        duplicate: 0,
        blocked_dnc: 0,
        invalid: 0,
        dncChecked,
        dedupeKeys: settings.dedupeKeys,
        requiredFields: settings.requiredFields,
      };
      for (const candidate of candidates) summary[candidate.status] += 1;

      await tx.query(
        `UPDATE runs SET status = 'done', finished_at = now(), summary_json = $2::jsonb,
                         params_json = params_json || $3::jsonb WHERE id = $1`,
        [run.id, JSON.stringify(summary), JSON.stringify({ mapping })],
      );
      await tx.query("UPDATE sources SET config_json = config_json || $2::jsonb WHERE id = $1", [
        run.source_id,
        JSON.stringify({ mapping }),
      ]);
      await logAudit(tx, input.user, "import.processed", `run:${run.id}`, { ...summary, mapping });
      return summary;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.query("UPDATE runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [run.id, message]);
    await logAudit(db, "system" as Actor, "import.failed", `run:${run.id}`, { error: message });
    throw new ImportError(`The import failed and nothing was saved: ${message}`);
  }
}

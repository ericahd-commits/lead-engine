import { hashPassword, type User } from "../src/auth.js";
import { createPgliteDb, one, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createImport, processImport, type RunSummary } from "../src/pipeline/importRun.js";
import { guessMapping } from "../src/pipeline/mapping.js";
import { parseCsv } from "../src/pipeline/csv.js";

export async function freshDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}

export async function addUser(db: Db, name: string, role: User["role"]): Promise<User> {
  const email = `${name.toLowerCase()}@example.test`;
  const row = await one<{ id: number }>(
    db,
    "INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id",
    [email, name, role, await hashPassword("correct horse battery")],
  );
  return { id: row!.id, email, name, role, active: true };
}

export async function importCsv(db: Db, user: User, text: string, source = "Test source"): Promise<{ runId: number; summary: RunSummary }> {
  const { runId } = await createImport(db, { user, sourceName: source, fileName: "test.csv", text, maxRows: 1000 });
  const mapping = guessMapping(parseCsv(text, 1000).headers);
  const summary = await processImport(db, { runId, mapping, user });
  return { runId, summary };
}

export async function leadStatuses(db: Db, runId: number): Promise<{ name: string; status: string; reason: string | null }[]> {
  const result = await db.query<{ name: string; status: string; reason: string | null }>(
    "SELECT business_name AS name, status, status_reason AS reason FROM leads WHERE run_id = $1 ORDER BY id",
    [runId],
  );
  return result.rows;
}

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(db: Db): Promise<{ applied: string[] }> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const files = (await readdir(migrationsDir)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  const done = new Set(
    (await db.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((row) => row.version),
  );
  const applied: string[] = [];

  for (const file of files) {
    const version = path.basename(file, ".sql");
    if (done.has(version)) continue;
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    // Each migration is all-or-nothing, so a failed deploy never leaves half a schema behind.
    await db.tx(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    });
    applied.push(version);
  }

  return { applied };
}

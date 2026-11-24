import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export type Row = Record<string, unknown>;

// The one database interface the app uses. Two rules keep it identical on Postgres and on the
// local file database: lists and objects are passed as JSON text (`$1::jsonb`), never as arrays,
// and counts are cast to int in SQL.
export type Db = {
  query<T = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export async function one<T = Row>(db: Db, sql: string, params?: unknown[]): Promise<T | null> {
  const result = await db.query<T>(sql, params);
  return result.rows[0] ?? null;
}

export async function many<T = Row>(db: Db, sql: string, params?: unknown[]): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

export async function createPostgresDb(connectionString: string): Promise<Db> {
  const pg = await import("pg");
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({ connectionString, keepAlive: true });
  // An idle connection dropped by the server arrives as an "error" event; with no listener it
  // would take the whole process down. The next query opens a new connection.
  pool.on("error", (error: Error) => {
    console.warn(`[postgres] an idle connection was closed (${error.message}); it reopens on the next query.`);
  });

  type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> };

  const wrap = (target: Queryable, inTx: boolean): Db => ({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await target.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      await target.query(sql);
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (inTx) return await fn(wrap(target, true));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await fn(wrap(client, true));
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (!inTx) await pool.end();
    },
  });

  return wrap(pool, false);
}

// Two processes writing to one file database corrupt it beyond repair, so the folder is claimed
// with a lock file naming the process that has it open. A lock left by a dead process is ignored.
function claimDataDir(dataDir: string): void {
  const lock = `${dataDir}.lock`;
  if (existsSync(lock)) {
    const owner = Number(readFileSync(lock, "utf8"));
    let alive = false;
    if (Number.isInteger(owner) && owner > 0 && owner !== process.pid) {
      try {
        process.kill(owner, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (alive) {
      throw new Error(
        `The local database at ${dataDir} is already open in another process (pid ${owner}). Stop that one first; opening it twice would corrupt it.`,
      );
    }
  }
  writeFileSync(lock, String(process.pid));
  process.once("exit", () => {
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock);
    } catch {
      // The lock is already gone.
    }
  });
}

// PGlite: real Postgres compiled to run in-process. Used for tests (in memory) and for local
// work with no DATABASE_URL (a folder on disk). Never used in production.
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) {
    await mkdir(path.dirname(dataDir), { recursive: true });
    claimDataDir(dataDir);
  }
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  await lite.waitReady;

  type Queryable = {
    query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
    exec(sql: string): Promise<unknown>;
  };

  const wrap = (target: Queryable, inTx: boolean): Db => ({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await target.query<T>(sql, params as unknown[]);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await target.exec(sql);
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (inTx) return await fn(wrap(target, true));
      return await lite.transaction(async (transaction) => await fn(wrap(transaction as unknown as Queryable, true)));
    },
    async close() {
      if (!inTx) await lite.close();
    },
  });

  return wrap(lite as unknown as Queryable, false);
}

export async function openDb(databaseUrl: string | null): Promise<Db> {
  if (databaseUrl) return await createPostgresDb(databaseUrl);
  const dataDir = path.resolve(".data", "pglite");
  console.warn(`[db] DATABASE_URL is not set; using a local file database at ${dataDir}. Development only.`);
  return await createPgliteDb(dataDir);
}

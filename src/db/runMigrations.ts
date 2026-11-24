import "dotenv/config";
import { loadConfig } from "../config.js";
import { openDb } from "./db.js";
import { migrate } from "./migrate.js";

const config = loadConfig();
const db = await openDb(config.databaseUrl);
try {
  const { applied } = await migrate(db);
  console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database is up to date.");
} finally {
  await db.close();
}

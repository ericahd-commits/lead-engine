import "dotenv/config";
import { serve } from "@hono/node-server";
import { bootstrapAdmin } from "../auth.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/db.js";
import { migrate } from "../db/migrate.js";
import { createApp } from "./app.js";

const config = loadConfig();
const db = await openDb(config.databaseUrl);

const { applied } = await migrate(db);
if (applied.length > 0) console.log(`[db] applied migrations: ${applied.join(", ")}`);

const admin = await bootstrapAdmin(db, config);
if (admin === "created") console.log(`[auth] created the first admin account for ${config.adminEmail}`);
if (admin === "missing") {
  console.warn("[auth] there are no accounts yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) and restart.");
}

const app = createApp({ db, config });
const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`[web] Lead Engine is listening on port ${info.port}`);
  console.log(`[web] external writes: ${config.externalWritesEnabled ? "ON" : "OFF"}; two-person approval: ${config.requireSecondApprover ? "ON" : "OFF"}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await db.close().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

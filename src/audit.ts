import type { Db } from "./db/db.js";

export type Actor = { id: number; email: string } | "system";

export async function logAudit(
  db: Db,
  actor: Actor,
  action: string,
  subject: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  const actorText = actor === "system" ? "system" : `user:${actor.id} ${actor.email}`;
  await db.query(
    "INSERT INTO audit_log (actor, action, subject, details_json) VALUES ($1, $2, $3, $4::jsonb)",
    [actorText, action, subject, JSON.stringify(details)],
  );
}

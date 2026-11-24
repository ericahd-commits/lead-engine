import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { logAudit } from "./audit.js";
import type { Config } from "./config.js";
import { many, one, type Db } from "./db/db.js";

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export class AuthError extends Error {}

export const ROLES = ["admin", "reviewer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export type User = { id: number; email: string; name: string; role: Role; active: boolean };
export type Session = { user: User; csrfToken: string; tokenHash: string };

export const SESSION_COOKIE = "le_session";
const SESSION_DAYS = 14;
const MIN_PASSWORD = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD) throw new AuthError(`Passwords need at least ${MIN_PASSWORD} characters.`);
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD, only while there are no users.
export async function bootstrapAdmin(db: Db, config: Config): Promise<"created" | "exists" | "missing"> {
  const existing = await one<{ count: number }>(db, "SELECT count(*)::int AS count FROM users");
  if ((existing?.count ?? 0) > 0) return "exists";
  if (!config.adminEmail || !config.adminPassword) return "missing";
  checkPassword(config.adminPassword);
  await db.query("INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, 'admin', $3)", [
    config.adminEmail,
    config.adminName ?? config.adminEmail.split("@")[0],
    await hashPassword(config.adminPassword),
  ]);
  await logAudit(db, "system", "user.bootstrap_admin", null, { email: config.adminEmail });
  return "created";
}

// A few wrong passwords lock that email + address pair out for a while. Kept in memory: it only
// has to slow guessing down, and a restart clearing it is harmless.
const attempts = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export async function login(db: Db, input: { email: string; password: string; ip: string }): Promise<{ token: string }> {
  const email = input.email.trim().toLowerCase();
  const key = `${email}|${input.ip}`;
  const now = Date.now();
  const record = attempts.get(key);
  if (record && now - record.first < WINDOW_MS && record.count >= MAX_ATTEMPTS) {
    throw new AuthError("Too many attempts. Wait 15 minutes and try again.");
  }

  const user = await one<{ id: number; password_hash: string; active: boolean }>(
    db,
    "SELECT id, password_hash, active FROM users WHERE email = $1",
    [email],
  );
  const ok = user ? await verifyPassword(input.password, user.password_hash) : false;
  if (!user || !ok || !user.active) {
    const base = record && now - record.first < WINDOW_MS ? record : { count: 0, first: now };
    attempts.set(key, { count: base.count + 1, first: base.first });
    await logAudit(db, "system", "login.failed", null, { email });
    throw new AuthError("That email and password do not match an active account.");
  }
  attempts.delete(key);

  const token = randomBytes(32).toString("hex");
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [hashToken(token), user.id, randomBytes(24).toString("hex"), String(SESSION_DAYS)],
  );
  await db.query("DELETE FROM sessions WHERE expires_at < now()");
  await logAudit(db, { id: user.id, email }, "login.ok", null, {});
  return { token };
}

export async function getSession(db: Db, token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = await one<User & { csrf_token: string }>(
    db,
    `SELECT u.id, u.email, u.name, u.role, u.active, s.csrf_token
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [tokenHash],
  );
  if (!row) return null;
  const { csrf_token: csrfToken, ...user } = row;
  return { user, csrfToken, tokenHash };
}

export async function logout(db: Db, session: Session): Promise<void> {
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [session.tokenHash]);
}

export async function listUsers(db: Db): Promise<(User & { created_at: Date })[]> {
  return await many(db, "SELECT id, email, name, role, active, created_at FROM users ORDER BY active DESC, name");
}

export async function createUser(
  db: Db,
  actor: User,
  input: { email: string; name: string; role: string; password: string },
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError("Enter a valid email address.");
  if (!name) throw new AuthError("Enter the person's name.");
  if (!ROLES.includes(input.role as Role)) throw new AuthError("Choose a role.");
  checkPassword(input.password);
  if (await one(db, "SELECT 1 FROM users WHERE email = $1", [email])) throw new AuthError("That email already has an account.");
  await db.query("INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)", [
    email,
    name,
    input.role,
    await hashPassword(input.password),
  ]);
  await logAudit(db, actor, "user.created", null, { email, role: input.role });
}

export async function updateUser(
  db: Db,
  actor: User,
  input: { userId: number; role: string; active: boolean; password: string | null },
): Promise<void> {
  if (!ROLES.includes(input.role as Role)) throw new AuthError("Choose a role.");
  await db.tx(async (tx) => {
    const target = await one<User>(tx, "SELECT id, email, name, role, active FROM users WHERE id = $1", [input.userId]);
    if (!target) throw new AuthError("That account does not exist.");

    // The app must never be left with nobody able to approve or manage accounts.
    const losingAdmin = target.role === "admin" && target.active && (input.role !== "admin" || !input.active);
    if (losingAdmin) {
      const others = await one<{ count: number }>(
        tx,
        "SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND active AND id <> $1",
        [target.id],
      );
      if ((others?.count ?? 0) === 0) throw new AuthError("This is the only active admin. Make someone else an admin first.");
    }

    await tx.query("UPDATE users SET role = $2, active = $3 WHERE id = $1", [target.id, input.role, input.active]);
    if (input.password) {
      checkPassword(input.password);
      await tx.query("UPDATE users SET password_hash = $2 WHERE id = $1", [target.id, await hashPassword(input.password)]);
    }
    if (!input.active || input.password) await tx.query("DELETE FROM sessions WHERE user_id = $1", [target.id]);
    await logAudit(tx, actor, "user.updated", null, {
      email: target.email,
      role: input.role,
      active: input.active,
      passwordReset: Boolean(input.password),
    });
  });
}

export async function changeOwnPassword(db: Db, session: Session, current: string, next: string): Promise<void> {
  const row = await one<{ password_hash: string }>(db, "SELECT password_hash FROM users WHERE id = $1", [session.user.id]);
  if (!row || !(await verifyPassword(current, row.password_hash))) throw new AuthError("The current password is wrong.");
  checkPassword(next);
  await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [session.user.id, await hashPassword(next)]);
  // Every other signed-in browser for this account is signed out.
  await db.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [session.user.id, session.tokenHash]);
  await logAudit(db, session.user, "user.password_changed", null, {});
}

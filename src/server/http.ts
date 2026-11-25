import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ApprovalError } from "../approvals.js";
import { AuthError, type Role, type Session } from "../auth.js";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import { DeleteError } from "../deletes.js";
import { ExportError } from "../exports.js";
import { GateError } from "../gate.js";
import { CsvError } from "../pipeline/csv.js";
import { DncError } from "../pipeline/dnc.js";
import { ImportError } from "../pipeline/importRun.js";
import { KnownError } from "../pipeline/known.js";
import { ReviewError } from "../reviews.js";

export type FormData = Record<string, string | File | (string | File)[]>;
// The counts the sidebar shows on every page.
export type NavState = { pending: number; unmapped: number; inReview: number; externalWrites: boolean };
export type Env = { Variables: { session: Session; form: FormData; nav: NavState } };
export type App = Hono<Env>;
export type Ctx = Context<Env>;
export type Deps = { db: Db; config: Config };

const RANK: Record<Role, number> = { viewer: 0, reviewer: 1, admin: 2 };

export function can(session: Session, role: Role): boolean {
  return RANK[session.user.role] >= RANK[role];
}

export function need(c: Ctx, role: Role): Session {
  const session = c.get("session");
  if (!can(session, role)) {
    throw new HTTPException(403, { message: `This needs the ${role} role. Your account is a ${session.user.role}.` });
  }
  return session;
}

export function str(form: FormData, key: string): string {
  const value = form[key];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}

export function list(form: FormData, key: string): string[] {
  const value = form[key];
  const all = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return all.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

export function file(form: FormData, key: string): File | null {
  const value = form[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first instanceof File && first.size > 0 ? first : null;
}

export function idParam(c: Ctx, name = "id"): number {
  const value = Number(c.req.param(name));
  if (!Number.isInteger(value) || value <= 0) throw new HTTPException(404, { message: "Not found." });
  return value;
}

// Uploaded text files are usually UTF-8, but a CSV saved from Excel is often Windows-1252 and
// some exports are UTF-16. Decoding the wrong way would silently mangle business names.
export async function readUpload(upload: File, maxBytes: number): Promise<string> {
  if (upload.size > maxBytes) {
    throw new CsvError(`The file is ${(upload.size / 1024 / 1024).toFixed(1)} MB; the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
  const bytes = new Uint8Array(await upload.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export function withMessage(path: string, kind: "ok" | "err", message: string): string {
  const url = new URL(path, "http://local");
  url.searchParams.delete("ok");
  url.searchParams.delete("err");
  url.searchParams.set(kind, message);
  return `${url.pathname}${url.search}`;
}

export function ok(c: Ctx, path: string, message: string): Response {
  return c.redirect(withMessage(path, "ok", message), 303);
}

// Mistakes a person can fix (a bad file, a missing reason, an action that is not allowed yet).
// They go back to the page they came from with the message; anything else is a real error.
export function isUserError(error: unknown): boolean {
  return [ApprovalError, AuthError, DeleteError, ExportError, GateError, CsvError, DncError, ImportError, KnownError, ReviewError].some(
    (type) => error instanceof type,
  );
}

export function refererPath(c: Ctx, fallback: string): string {
  const referer = c.req.header("referer");
  if (!referer) return fallback;
  try {
    const url = new URL(referer);
    if (url.host !== c.req.header("host")) return fallback;
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

export function clientIp(c: Ctx): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

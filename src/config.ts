import { z } from "zod";

const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      const text = value?.trim().toLowerCase();
      if (!text) return fallback;
      return text === "true" || text === "1" || text === "yes";
    });

const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.string().default("development"),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_NAME: z.string().optional(),
  // Off unless someone turns it on. No adapter may write to or spend on an outside system
  // without checking this first.
  EXTERNAL_WRITES_ENABLED: flag(false),
  APPROVALS_REQUIRE_SECOND_PERSON: flag(false),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(25),
  MAX_IMPORT_ROWS: z.coerce.number().int().positive().default(100_000),
});

export type Config = {
  databaseUrl: string | null;
  port: number;
  production: boolean;
  adminEmail: string | null;
  adminPassword: string | null;
  adminName: string | null;
  externalWritesEnabled: boolean;
  requireSecondApprover: boolean;
  maxUploadBytes: number;
  maxImportRows: number;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.parse(env);
  const production = parsed.NODE_ENV === "production";
  const databaseUrl = parsed.DATABASE_URL?.trim() || null;

  if (production && !databaseUrl) {
    throw new Error("DATABASE_URL is required in production. The file database is for local work only.");
  }

  return {
    databaseUrl,
    port: parsed.PORT,
    production,
    adminEmail: parsed.ADMIN_EMAIL?.trim().toLowerCase() || null,
    adminPassword: parsed.ADMIN_PASSWORD || null,
    adminName: parsed.ADMIN_NAME?.trim() || null,
    externalWritesEnabled: parsed.EXTERNAL_WRITES_ENABLED,
    requireSecondApprover: parsed.APPROVALS_REQUIRE_SECOND_PERSON,
    maxUploadBytes: Math.floor(parsed.MAX_UPLOAD_MB * 1024 * 1024),
    maxImportRows: parsed.MAX_IMPORT_ROWS,
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: null,
    port: 0,
    production: false,
    adminEmail: null,
    adminPassword: null,
    adminName: null,
    externalWritesEnabled: false,
    requireSecondApprover: false,
    maxUploadBytes: 25 * 1024 * 1024,
    maxImportRows: 100_000,
    ...overrides,
  };
}

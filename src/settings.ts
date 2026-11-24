import { z } from "zod";
import type { Db } from "./db/db.js";

export const DEDUPE_KEYS = ["phone", "domain", "name_city"] as const;
export type DedupeKey = (typeof DEDUPE_KEYS)[number];

export const REQUIRABLE_FIELDS = [
  "business_name",
  "phone_e164",
  "website_domain",
  "email",
  "address",
  "city",
  "region",
  "postal_code",
  "category",
] as const;
export type RequirableField = (typeof REQUIRABLE_FIELDS)[number];

const settingsSchema = z.object({
  // TODO (briefing question 3): confirm what makes two leads "the same".
  dedupeKeys: z.array(z.enum(DEDUPE_KEYS)),
  // Websites that many unrelated businesses share. A match on one of these is not a duplicate.
  sharedDomains: z.array(z.string()),
  // TODO (briefing question 1): confirm the real lead criteria. A lead missing any of these is
  // kept, marked invalid, and never reaches review.
  requiredFields: z.array(z.enum(REQUIRABLE_FIELDS)),
  // Country assumed for phone numbers written without a country code.
  defaultCountry: z.string().length(2),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  dedupeKeys: ["phone", "domain"],
  sharedDomains: [
    "facebook.com",
    "m.facebook.com",
    "instagram.com",
    "linktr.ee",
    "yelp.com",
    "google.com",
    "business.site",
    "sites.google.com",
    "linkedin.com",
    "twitter.com",
    "x.com",
    "tiktok.com",
    "youtube.com",
    "wixsite.com",
    "square.site",
    "vagaro.com",
    "mindbodyonline.com",
    "booksy.com",
    "squareup.com",
    "bit.ly",
  ],
  requiredFields: ["business_name", "phone_e164"],
  defaultCountry: "US",
};

export async function loadSettings(db: Db): Promise<Settings> {
  const rows = (await db.query<{ key: string; value: unknown }>("SELECT key, value FROM settings")).rows;
  const stored: Record<string, unknown> = {};
  for (const row of rows) stored[row.key] = row.value;
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(db: Db, next: Settings, userId: number): Promise<Settings> {
  const clean = settingsSchema.parse({
    ...next,
    defaultCountry: next.defaultCountry.trim().toUpperCase(),
    sharedDomains: [...new Set(next.sharedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))],
  });
  for (const [key, value] of Object.entries(clean)) {
    await db.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), userId],
    );
  }
  return clean;
}

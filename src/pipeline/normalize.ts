import { findPhoneNumbersInText, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

// A phone number in E.164 (+14155550123), or null when the text holds no valid number.
// A cell with several numbers ("555-1234 / 555-9999") gives the first valid one.
export function normalizePhone(raw: unknown, defaultCountry: string): string | null {
  const text = cleanText(raw);
  if (!text) return null;
  const country = defaultCountry.toUpperCase() as CountryCode;

  try {
    const direct = parsePhoneNumberFromString(text, country);
    if (direct?.isValid()) return direct.number;
  } catch {
    // fall through to the search below
  }

  try {
    for (const found of findPhoneNumbersInText(text, country)) {
      if (found.number.isValid()) return found.number.number;
    }
  } catch {
    // unknown country code or unparseable text
  }
  return null;
}

// The national number and calling code a dialer wants, from an E.164 number.
export function splitPhone(e164: string | null): { callingCode: string; national: string } | null {
  if (!e164) return null;
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return null;
  return { callingCode: parsed.countryCallingCode, national: parsed.nationalNumber };
}

// The host of a website, lower-cased and without "www.". Sub-domains are kept on purpose:
// locations.brand.com and brand.com may be different businesses.
export function normalizeDomain(raw: unknown): string | null {
  const text = cleanText(raw);
  if (!text) return null;
  const first = text.split(/[\s,;|]+/)[0] ?? "";
  if (!first || first.includes("@")) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `https://${first}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

export function normalizeEmail(raw: unknown): string | null {
  const text = cleanText(raw);
  if (!text) return null;
  const match = text.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return match ? match[0] : null;
}

const NAME_SUFFIXES = new Set(["llc", "inc", "ltd", "co", "corp", "corporation", "company", "pllc", "pc", "lp", "llp", "the"]);

function keyPart(value: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// "Joe's Pizza, LLC" in "Dayton", "OH" -> "joes pizza|dayton|oh". Null unless both a name and a
// city are present: a name alone is far too weak to call two leads the same.
export function nameCityKey(name: string | null, city: string | null, region: string | null): string | null {
  const nameKey = keyPart(name?.replace(/['’`]/g, "") ?? null)
    .split(" ")
    .filter((word) => word && !NAME_SUFFIXES.has(word))
    .join(" ");
  const cityKey = keyPart(city);
  if (!nameKey || !cityKey) return null;
  return `${nameKey}|${cityKey}|${keyPart(region)}`;
}

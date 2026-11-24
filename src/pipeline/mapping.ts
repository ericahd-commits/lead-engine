export const LEAD_FIELDS = [
  "business_name",
  "phone",
  "website",
  "email",
  "owner_name",
  "address",
  "city",
  "region",
  "postal_code",
  "country",
  "category",
] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];

export const FIELD_LABELS: Record<LeadField, string> = {
  business_name: "Business name",
  phone: "Phone",
  website: "Website",
  email: "Email",
  owner_name: "Owner name",
  address: "Street address",
  city: "City",
  region: "State / region",
  postal_code: "ZIP / postal code",
  country: "Country",
  category: "Category",
};

// Which file column feeds each lead field. An empty string means "not in this file".
export type ColumnMapping = Record<LeadField, string>;

const SYNONYMS: Record<LeadField, string[]> = {
  business_name: ["business name", "company name", "company", "business", "name", "title", "place name", "store name"],
  phone: ["phone", "phone number", "telephone", "tel", "phone 1", "contact phone", "business phone", "mobile"],
  website: ["website", "web site", "url", "site", "domain", "homepage", "web", "website url"],
  email: ["email", "e-mail", "email address", "contact email"],
  owner_name: ["owner", "owner name", "contact name", "contact", "full name", "decision maker"],
  address: ["address", "street", "street address", "address 1", "full address", "address line 1"],
  city: ["city", "town", "locality"],
  region: ["state", "region", "province", "state/region", "st"],
  postal_code: ["zip", "zip code", "postal code", "postcode", "postal"],
  country: ["country", "country code"],
  category: ["category", "categories", "industry", "type", "vertical", "business type", "niche"],
};

const simplify = (value: string) => value.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();

// A first guess at the mapping from the header names. The person uploading always confirms it.
export function guessMapping(headers: string[], saved?: Partial<ColumnMapping> | null): ColumnMapping {
  const mapping = {} as ColumnMapping;
  const used = new Set<string>();

  for (const field of LEAD_FIELDS) {
    const remembered = saved?.[field];
    if (remembered && headers.includes(remembered)) {
      mapping[field] = remembered;
      used.add(remembered);
    } else {
      mapping[field] = "";
    }
  }

  for (const field of LEAD_FIELDS) {
    if (mapping[field]) continue;
    for (const synonym of SYNONYMS[field]) {
      const hit = headers.find((header) => !used.has(header) && simplify(header) === synonym);
      if (hit) {
        mapping[field] = hit;
        used.add(hit);
        break;
      }
    }
  }
  return mapping;
}

export function cleanMapping(input: Record<string, unknown>, headers: string[]): ColumnMapping {
  const mapping = {} as ColumnMapping;
  for (const field of LEAD_FIELDS) {
    const value = input[field];
    mapping[field] = typeof value === "string" && headers.includes(value) ? value : "";
  }
  return mapping;
}

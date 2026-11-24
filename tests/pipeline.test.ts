import { describe, expect, it } from "vitest";
import { CsvError, parseCsv } from "../src/pipeline/csv.js";
import { extractDncNumbers, uploadDncList } from "../src/pipeline/dnc.js";
import { guessMapping } from "../src/pipeline/mapping.js";
import { nameCityKey, normalizeDomain, normalizeEmail, normalizePhone } from "../src/pipeline/normalize.js";
import { DEFAULT_SETTINGS, saveSettings } from "../src/settings.js";
import { addUser, freshDb, importCsv, leadStatuses } from "./helpers.js";

describe("normalizing", () => {
  it("turns phone numbers into E.164 and refuses what is not a number", () => {
    expect(normalizePhone("(937) 729-3270", "US")).toBe("+19377293270");
    expect(normalizePhone("937.729.3270 ext 12", "US")).toBe("+19377293270");
    expect(normalizePhone("+44 20 7946 0958", "US")).toBe("+442079460958");
    expect(normalizePhone("call 937-729-3270 or 937-729-3271", "US")).toBe("+19377293270");
    expect(normalizePhone("555-1234", "US")).toBeNull();
    expect(normalizePhone("n/a", "US")).toBeNull();
    expect(normalizePhone("", "US")).toBeNull();
  });

  it("reduces a website to its host and keeps sub-domains", () => {
    expect(normalizeDomain("https://www.Example.com/contact?x=1")).toBe("example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
    expect(normalizeDomain("locations.brand.com/dayton")).toBe("locations.brand.com");
    expect(normalizeDomain("owner@example.com")).toBeNull();
    expect(normalizeDomain("none")).toBeNull();
  });

  it("builds a name-and-city key only when both are present", () => {
    expect(nameCityKey("Joe's Pizza, LLC", "Dayton", "OH")).toBe("joes pizza|dayton|oh");
    expect(nameCityKey("JOES PIZZA", "dayton", "oh")).toBe("joes pizza|dayton|oh");
    expect(nameCityKey("Joe's Pizza", null, "OH")).toBeNull();
  });

  it("pulls an email out of surrounding text", () => {
    expect(normalizeEmail("Mail: Owner@Example.com")).toBe("owner@example.com");
    expect(normalizeEmail("none")).toBeNull();
  });
});

describe("reading CSV files", () => {
  it("keeps every column, naming blank and repeated headers", () => {
    const parsed = parseCsv("Name,Phone,,Phone\nA,1,x,2\n", 100);
    expect(parsed.headers).toEqual(["Name", "Phone", "column_3", "Phone (2)"]);
    expect(parsed.rows[0]).toEqual({ Name: "A", Phone: "1", column_3: "x", "Phone (2)": "2" });
  });

  it("reads semicolon files and skips blank lines", () => {
    const parsed = parseCsv("﻿Name;City\nA;Dayton\n;\n\nB;Troy\n", 100);
    expect(parsed.rows.map((row) => row.Name)).toEqual(["A", "B"]);
  });

  it("explains itself on Excel files, empty files and files that are too long", () => {
    expect(() => parseCsv("PK\u0003\u0004binary", 100)).toThrow(/Excel/);
    expect(() => parseCsv("  \n", 100)).toThrow(CsvError);
    expect(() => parseCsv("Name\n", 100)).toThrow(/no data rows/);
    expect(() => parseCsv("Name\nA\nB\nC\n", 2)).toThrow(/limit is 2/);
  });

  it("guesses a mapping from common header names and prefers a saved one", () => {
    const headers = ["Title", "Phone Number", "Web", "State", "Zip Code", "Biz"];
    expect(guessMapping(headers)).toMatchObject({
      business_name: "Title",
      phone: "Phone Number",
      website: "Web",
      region: "State",
      postal_code: "Zip Code",
      city: "",
    });
    expect(guessMapping(headers, { business_name: "Biz" }).business_name).toBe("Biz");
  });
});

const FILE = [
  "Name,Phone,Website,City,State",
  "Alpha Gym,(937) 555-0101,alphagym.com,Dayton,OH",
  "Alpha Gym Dayton,937-555-0101,,Dayton,OH", // same phone as row 1
  "Beta Spa,937-555-0102,https://www.betaspa.com/book,Troy,OH",
  "Beta Spa West,937-555-0103,betaspa.com,Troy,OH", // same website as row 3
  "Gamma Salon,937-555-0104,facebook.com/gammasalon,Dayton,OH",
  "Delta Salon,937-555-0105,facebook.com/deltasalon,Dayton,OH", // shared host, not a duplicate
  "No Phone Co,call us,nophone.com,Dayton,OH",
  ",937-555-0106,noname.com,Dayton,OH",
].join("\n");

describe("importing a file", () => {
  it("sorts rows into review, duplicate and invalid, and says why", async () => {
    const db = await freshDb();
    const user = await addUser(db, "Rita", "reviewer");
    const { runId, summary } = await importCsv(db, user, FILE);

    expect(summary).toMatchObject({ total: 8, in_review: 4, duplicate: 2, invalid: 2, blocked_dnc: 0, dncChecked: false });
    const leads = await leadStatuses(db, runId);
    expect(leads.map((lead) => lead.status)).toEqual([
      "in_review",
      "duplicate",
      "in_review",
      "duplicate",
      "in_review",
      "in_review",
      "invalid",
      "invalid",
    ]);
    expect(leads[1]!.reason).toMatch(/^Same phone as lead #\d+$/);
    expect(leads[3]!.reason).toMatch(/^Same website as lead #\d+$/);
    expect(leads[6]!.reason).toBe('Missing required: phone ("call us" is not a valid number)');
    expect(leads[7]!.reason).toBe("Missing required: business name");

    // No DNC list was loaded, so no lead may claim to have been checked.
    const checked = await db.query("SELECT 1 FROM leads WHERE dnc_checked_at IS NOT NULL");
    expect(checked.rows).toHaveLength(0);
    const raw = await db.query("SELECT 1 FROM raw_records WHERE run_id = $1", [runId]);
    expect(raw.rows).toHaveLength(8);
    await db.close();
  });

  it("marks a lead that is already in the database as a duplicate of it", async () => {
    const db = await freshDb();
    const user = await addUser(db, "Rita", "reviewer");
    await importCsv(db, user, "Name,Phone\nAlpha Gym,937-555-0101\n");
    const second = await importCsv(db, user, "Name,Phone\nAlpha Fitness,(937) 555 0101\nNew Place,937-555-0199\n");
    expect(second.summary).toMatchObject({ in_review: 1, duplicate: 1 });
    const match = await db.query<{ rule_used: string; match_type: string }>(
      "SELECT rule_used, match_type FROM dedupe_matches",
    );
    expect(match.rows).toEqual([{ rule_used: "phone", match_type: "internal" }]);
    await db.close();
  });

  it("uses only the dedupe keys that are switched on", async () => {
    const db = await freshDb();
    const user = await addUser(db, "Ann", "admin");
    await saveSettings(db, { ...DEFAULT_SETTINGS, dedupeKeys: ["name_city"], requiredFields: ["business_name"] }, user.id);
    const { summary } = await importCsv(
      db,
      user,
      "Name,Phone,City,State\nJoe's Pizza LLC,937-555-0101,Dayton,OH\nJoes Pizza,937-555-0101,Dayton,OH\nJoes Pizza,937-555-0101,Troy,OH\n",
    );
    expect(summary).toMatchObject({ in_review: 2, duplicate: 1 });
    await db.close();
  });

  it("blocks numbers on a DNC list at import and when a list arrives later", async () => {
    const db = await freshDb();
    const user = await addUser(db, "Rita", "reviewer");
    const first = await importCsv(db, user, "Name,Phone\nAlpha Gym,937-555-0101\nBeta Spa,937-555-0102\n");
    expect(first.summary.dncChecked).toBe(false);

    const upload = await uploadDncList(db, {
      user,
      name: "Internal DNC",
      fileName: "dnc.csv",
      text: "phone\n(937) 555-0102\n937-555-0150\nnot a number\n",
      defaultCountry: "US",
    });
    expect(upload).toMatchObject({ numbers: 2, unreadable: ["not a number"], recheck: { newlyBlocked: 1 } });
    expect((await leadStatuses(db, first.runId)).map((lead) => lead.status)).toEqual(["in_review", "blocked_dnc"]);

    const second = await importCsv(db, user, "Name,Phone\nGamma Salon,937-555-0150\nDelta Salon,937-555-0151\n");
    expect(second.summary).toMatchObject({ blocked_dnc: 1, in_review: 1, dncChecked: true });
    const leads = await leadStatuses(db, second.runId);
    expect(leads[0]!.reason).toBe('Phone is on the DNC list "Internal DNC"');
    await db.close();
  });

  it("finds numbers in any column of a DNC file and skips a header", () => {
    const found = extractDncNumbers("Name,Number\nJo,937-555-0101\n,9375550102\nbad,12\n", "US");
    expect(found.numbers.sort()).toEqual(["+19375550101", "+19375550102"]);
    expect(found.unreadable).toEqual(["bad, 12"]);
  });
});

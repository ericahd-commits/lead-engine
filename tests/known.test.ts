import { describe, expect, it } from "vitest";
import { decideApproval, requestApproval } from "../src/approvals.js";
import { testConfig } from "../src/config.js";
import { createBatch, checkBatch } from "../src/exports.js";
import { uploadDncList } from "../src/pipeline/dnc.js";
import { extractKnownNumbers, uploadKnownList } from "../src/pipeline/known.js";
import { decideLeads } from "../src/reviews.js";
import { createApp } from "../src/server/app.js";
import { addUser, freshDb, importCsv, leadStatuses } from "./helpers.js";

const config = testConfig();
const THREE = "Name,Phone\nAlpha Gym,937-555-0101\nBeta Spa,937-555-0102\nGamma Salon,937-555-0103\n";
const upload = (kind: string, name: string, text: string) => ({ kind, name, fileName: `${name}.csv`, text, defaultCountry: "US" });

describe("reading an export from VICIdial or Close", () => {
  it("reads only the phone columns when the file names them", () => {
    // vendor_lead_code holds a ten-digit id that would pass for a phone number.
    const text = "lead_id,vendor_lead_code,phone_code,phone_number,alt_phone\n1,9375550199,1,9375550101,\n2,9375550198,1,,(937) 555-0102\n3,9375550197,1,,\n";
    const result = extractKnownNumbers(text, "US");
    expect(result.numbers.sort()).toEqual(["+19375550101", "+19375550102"]);
    expect(result).toMatchObject({ rows: 3, rowsWithoutNumber: 1, columns: ["phone_code", "phone_number", "alt_phone"] });
  });

  it("scans every column of a tab-separated file with no header, and says so", () => {
    const result = extractKnownNumbers("1\tNEW\t1048\t9375550101\tAlpha, Gym\n2\tNEW\t1048\t(937) 555-0102\tBeta\n", "US");
    expect(result.numbers.sort()).toEqual(["+19375550101", "+19375550102"]);
    expect(result).toMatchObject({ rows: 2, rowsWithoutNumber: 0, columns: null });
  });
});

describe("leads that already exist elsewhere", () => {
  it("holds them back at import, with DNC outranking and Close named over VICIdial", async () => {
    const db = await freshDb();
    const user = await addUser(db, "Rita", "reviewer");
    await uploadKnownList(db, { user, ...upload("vici", "List 1048", "phone_number\n9375550101\n9375550102\n9375550103\n") });
    await uploadKnownList(db, { user, ...upload("close", "Close leads", "Primary Phone\n+1 937-555-0102\n") });
    await uploadDncList(db, { user, name: "Internal", fileName: "d.csv", text: "9375550103\n", defaultCountry: "US" });

    const { runId, summary } = await importCsv(db, user, `${THREE}Delta Yoga,937-555-0104\n`);
    expect(await leadStatuses(db, runId)).toEqual([
      { name: "Alpha Gym", status: "in_vici", reason: 'Phone is already in VICIdial, per the file "List 1048"' },
      { name: "Beta Spa", status: "in_close", reason: 'Phone is already in Close, per the file "Close leads"' },
      { name: "Gamma Salon", status: "blocked_dnc", reason: 'Phone is on the DNC list "Internal"' },
      { name: "Delta Yoga", status: "in_review", reason: null },
    ]);
    expect(summary).toMatchObject({ in_review: 1, in_vici: 1, in_close: 1, blocked_dnc: 1, viciChecked: true, closeChecked: true });
    await db.close();
  });

  it("says an import was not compared when no file was loaded", async () => {
    const db = await freshDb();
    const user = await addUser(db, "Rita", "reviewer");
    const { summary } = await importCsv(db, user, THREE);
    expect(summary).toMatchObject({ in_review: 3, viciChecked: false, closeChecked: false });
    await db.close();
  });

  it("pulls an approved lead out of a batch when a later file contains it", async () => {
    const db = await freshDb();
    const user = await addUser(db, "Rita", "reviewer");
    const { runId } = await importCsv(db, user, THREE);
    await decideLeads(db, { user, leadIds: [1, 2, 3], decision: "approve", reason: null });
    const { batchId } = await createBatch(db, { user, name: "Week 48", targetRef: null, runId: null });

    const result = await uploadKnownList(db, { user, ...upload("vici", "Fresh export", "phone\n937-555-0102\n") });
    expect(result.recheck.newlyMarked).toBe(1);
    expect((await leadStatuses(db, runId)).map((lead) => lead.status)).toEqual(["approved", "in_vici", "approved"]);
    expect((await checkBatch(db, batchId)).ineligible).toEqual([expect.objectContaining({ name: "Beta Spa" })]);
    await db.close();
  });

  it("deletes a file only after approval and releases only the leads no other file covers", async () => {
    const db = await freshDb();
    const admin = await addUser(db, "Ann", "admin");
    const { runId } = await importCsv(db, admin, THREE);
    const a = await uploadKnownList(db, { user: admin, ...upload("vici", "A", "phone\n9375550101\n9375550102\n") });
    await uploadKnownList(db, { user: admin, ...upload("close", "B", "phone\n9375550102\n") });
    // Beta is on both: the Close file arrived while it was already marked, so it still says VICIdial.
    expect((await leadStatuses(db, runId)).map((lead) => lead.status)).toEqual(["in_vici", "in_vici", "in_review"]);

    const { approvalId } = await requestApproval(db, { user: admin, subjectType: "known_list", subjectId: a.listId });
    expect((await leadStatuses(db, runId)).map((lead) => lead.status)).toEqual(["in_vici", "in_vici", "in_review"]);
    const result = await decideApproval(db, config, { user: admin, approvalId, approve: true });
    expect(result.message).toBe('VICIdial file "A" deleted: 2 number(s) removed, 1 lead(s) no longer marked.');
    expect(await leadStatuses(db, runId)).toEqual([
      { name: "Alpha Gym", status: "in_review", reason: null },
      { name: "Beta Spa", status: "in_close", reason: 'Phone is already in Close, per the file "B"' },
      { name: "Gamma Salon", status: "in_review", reason: null },
    ]);
    await db.close();
  });

  it("refuses a file with no numbers or no stated system", async () => {
    const db = await freshDb();
    const user = await addUser(db, "Rita", "reviewer");
    await expect(uploadKnownList(db, { user, ...upload("vici", "Empty", "phone\nnot a number\n") })).rejects.toThrow("No valid phone numbers");
    await expect(uploadKnownList(db, { user, ...upload("other", "X", "9375550101\n") })).rejects.toThrow("VICIdial or from Close");
    await db.close();
  });
});

describe("the existing records page", () => {
  it("shows what is and is not loaded to anyone signed in", async () => {
    const db = await freshDb();
    await addUser(db, "Vic", "viewer");
    const app = createApp({ db, config });
    const host = "leads.test";
    const body = new FormData();
    body.set("email", "vic@example.test");
    body.set("password", "correct horse battery");
    const signIn = await app.request(`http://${host}/login`, { method: "POST", body, headers: { host, origin: `https://${host}` } });
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;

    // The old address still leads to the Checks screen.
    const old = await app.request(`http://${host}/existing`, { headers: { host, cookie } });
    expect(old.status).toBe(303);
    expect(old.headers.get("location")).toBe("/checks");

    const page = await (await app.request(`http://${host}/checks`, { headers: { host, cookie } })).text();
    expect(page).toContain("Leads are not compared with what is already in VICIdial.");
    expect(page).toContain("Leads are not compared with what is already in Close.");
    expect(page).toContain("No DNC list is loaded.");
    // A viewer sees the state but gets no upload button.
    expect(page).not.toContain("Upload VICIdial export");
    const home = await (await app.request(`http://${host}/`, { headers: { host, cookie } })).text();
    expect(home).toContain("A DNC list and exports from VICIdial and Close. None is loaded yet.");
    await db.close();
  });
});

import { describe, expect, it } from "vitest";
import { decideApproval, requestApproval } from "../src/approvals.js";
import { testConfig } from "../src/config.js";
import { one, type Db } from "../src/db/db.js";
import { batchCsv, checkBatch, createBatch, downloadBatch, removeLeadsFromBatch, type BatchLead } from "../src/exports.js";
import { assertExternalWritesEnabled, GateError } from "../src/gate.js";
import { uploadDncList } from "../src/pipeline/dnc.js";
import { decideLeads, markNotDuplicate } from "../src/reviews.js";
import type { User } from "../src/auth.js";
import { addUser, freshDb, importCsv, leadStatuses } from "./helpers.js";

const config = testConfig();
const THREE = "Name,Phone\nAlpha Gym,937-555-0101\nBeta Spa,937-555-0102\nGamma Salon,937-555-0103\n";

async function approvedBatch(db: Db, reviewer: User): Promise<{ batchId: number; runId: number; leadIds: number[] }> {
  const { runId } = await importCsv(db, reviewer, THREE);
  const leads = await db.query<{ id: number }>("SELECT id FROM leads WHERE run_id = $1 ORDER BY id", [runId]);
  const leadIds = leads.rows.map((row) => row.id);
  await decideLeads(db, { user: reviewer, leadIds, decision: "approve", reason: null });
  const { batchId } = await createBatch(db, { user: reviewer, name: "Week 48", targetRef: null, runId: null });
  return { batchId, runId, leadIds };
}

const batchStatus = async (db: Db, id: number) =>
  (await one<{ status: string }>(db, "SELECT status FROM export_batches WHERE id = $1", [id]))!.status;

describe("the export gate", () => {
  it("gives no file until an admin has approved the batch", async () => {
    const db = await freshDb();
    const reviewer = await addUser(db, "Rita", "reviewer");
    const admin = await addUser(db, "Ann", "admin");
    const { batchId, runId } = await approvedBatch(db, reviewer);

    await expect(downloadBatch(db, config, { user: reviewer, batchId })).rejects.toThrow(/not been approved/);
    const { approvalId } = await requestApproval(db, { user: reviewer, subjectType: "export_batch", subjectId: batchId });
    await expect(downloadBatch(db, config, { user: reviewer, batchId })).rejects.toThrow(/not been approved/);

    await expect(decideApproval(db, config, { user: reviewer, approvalId, approve: true })).rejects.toThrow(/Only an admin/);
    const decided = await decideApproval(db, config, { user: admin, approvalId, approve: true });
    expect(decided.outcome).toBe("approved");

    const file = await downloadBatch(db, config, { user: reviewer, batchId });
    expect(file.csv.split("\n")[0]).toContain("phone_e164,phone_code,phone_number");
    expect(file.csv).toContain("Alpha Gym,+19375550101,1,9375550101");
    expect((await leadStatuses(db, runId)).every((lead) => lead.status === "exported")).toBe(true);
    expect(await batchStatus(db, batchId)).toBe("done");

    // The same file can be fetched again; the leads cannot be put in a second batch.
    await expect(downloadBatch(db, config, { user: reviewer, batchId })).resolves.toBeTruthy();
    await expect(createBatch(db, { user: reviewer, name: "Again", targetRef: null, runId: null })).rejects.toThrow(/no approved leads/);
    await db.close();
  });

  it("carries every column of the imported file into the export, in the file's order", async () => {
    const db = await freshDb();
    const reviewer = await addUser(db, "Rita", "reviewer");
    const admin = await addUser(db, "Ann", "admin");
    const enriched =
      "searchString,GOOGLE_TITLE,GOOGLE_TOTALSCORE,LAST_BAD_REVIEW_TEXT,city,PHONE,PHONE_UNFORMATTED\n" +
      'x,STRIDE Fitness,3.7,"-rude; and ""shady""",Tustin,(714) 951-0945,17149510945\n';
    const { runId } = await importCsv(db, reviewer, enriched);
    const leads = await db.query<{ id: number }>("SELECT id FROM leads WHERE run_id = $1", [runId]);
    await decideLeads(db, { user: reviewer, leadIds: leads.rows.map((row) => row.id), decision: "approve", reason: null });
    const { batchId } = await createBatch(db, { user: reviewer, name: "Enriched", targetRef: null, runId: null });
    const { approvalId } = await requestApproval(db, { user: reviewer, subjectType: "export_batch", subjectId: batchId });
    await decideApproval(db, config, { user: admin, approvalId, approve: true });

    const [header, row] = (await downloadBatch(db, config, { user: reviewer, batchId })).csv.split("\n");
    // A file column named like one of the app's own is kept under original_<name>.
    expect(header).toMatch(/,source,searchString,GOOGLE_TITLE,GOOGLE_TOTALSCORE,LAST_BAD_REVIEW_TEXT,original_city,PHONE,PHONE_UNFORMATTED$/);
    expect(row).toContain("STRIDE Fitness,+17149510945,1,7149510945");
    expect(row).toMatch(/,x,STRIDE Fitness,3\.7,"'-rude; and ""shady""",Tustin,\(714\) 951-0945,17149510945$/);
    await db.close();
  });

  it("drops the approval when the batch changes afterwards", async () => {
    const db = await freshDb();
    const reviewer = await addUser(db, "Rita", "reviewer");
    const admin = await addUser(db, "Ann", "admin");
    const { batchId, leadIds } = await approvedBatch(db, reviewer);
    const { approvalId } = await requestApproval(db, { user: reviewer, subjectType: "export_batch", subjectId: batchId });
    await decideApproval(db, config, { user: admin, approvalId, approve: true });

    await removeLeadsFromBatch(db, { user: reviewer, batchId, leadIds: [leadIds[0]!] });
    expect(await batchStatus(db, batchId)).toBe("draft");
    await expect(downloadBatch(db, config, { user: reviewer, batchId })).rejects.toThrow(/not been approved/);

    // Even with the batch forced back to "approved" behind the app's back, the old approval
    // does not cover the new content.
    await db.query("UPDATE export_batches SET status = 'approved' WHERE id = $1", [batchId]);
    await expect(downloadBatch(db, config, { user: reviewer, batchId })).rejects.toThrow(GateError);
    await db.close();
  });

  it("does not accept an approval row that no person stands behind", async () => {
    const db = await freshDb();
    const reviewer = await addUser(db, "Rita", "reviewer");
    const { batchId } = await approvedBatch(db, reviewer);
    await requestApproval(db, { user: reviewer, subjectType: "export_batch", subjectId: batchId });

    // A row cannot even be marked approved without an approver.
    await expect(db.query("UPDATE approvals SET status = 'approved' WHERE subject_id = $1", [batchId])).rejects.toThrow();
    await db.query("UPDATE export_batches SET status = 'approved' WHERE id = $1", [batchId]);
    await expect(downloadBatch(db, config, { user: reviewer, batchId })).rejects.toThrow(/not been approved by a person/);
    await db.close();
  });

  it("can require a second person", async () => {
    const db = await freshDb();
    const ann = await addUser(db, "Ann", "admin");
    const bob = await addUser(db, "Bob", "admin");
    const strict = testConfig({ requireSecondApprover: true });
    const { batchId } = await approvedBatch(db, ann);
    const { approvalId } = await requestApproval(db, { user: ann, subjectType: "export_batch", subjectId: batchId });

    await expect(decideApproval(db, strict, { user: ann, approvalId, approve: true })).rejects.toThrow(/someone else/);
    expect((await decideApproval(db, strict, { user: bob, approvalId, approve: true })).outcome).toBe("approved");
    await expect(downloadBatch(db, strict, { user: ann, batchId })).resolves.toBeTruthy();
    await db.close();
  });

  it("stops a lead whose number reached a DNC list after approval", async () => {
    const db = await freshDb();
    const reviewer = await addUser(db, "Rita", "reviewer");
    const admin = await addUser(db, "Ann", "admin");
    const { batchId } = await approvedBatch(db, reviewer);

    const before = await checkBatch(db, batchId);
    expect(before).toMatchObject({ leadCount: 3, ineligible: [], dncNeverLoaded: true });

    const { approvalId } = await requestApproval(db, { user: reviewer, subjectType: "export_batch", subjectId: batchId });
    await decideApproval(db, config, { user: admin, approvalId, approve: true });
    await uploadDncList(db, { user: admin, name: "Late list", fileName: "d.csv", text: "937-555-0102\n", defaultCountry: "US" });

    await expect(downloadBatch(db, config, { user: reviewer, batchId })).rejects.toThrow(/1 lead\(s\) in this batch can no longer be exported/);
    const check = await checkBatch(db, batchId);
    expect(check.ineligible).toEqual([expect.objectContaining({ name: "Beta Spa", reason: 'Phone is on the DNC list "Late list"' })]);
    expect(check.dncNeverLoaded).toBe(false);

    expect(await removeLeadsFromBatch(db, { user: reviewer, batchId, leadIds: "ineligible" })).toBe(1);
    const again = await requestApproval(db, { user: reviewer, subjectType: "export_batch", subjectId: batchId });
    await decideApproval(db, config, { user: admin, approvalId: again.approvalId, approve: true });
    const file = await downloadBatch(db, config, { user: reviewer, batchId });
    expect(file.csv).not.toContain("Beta Spa");
    await db.close();
  });

  it("refuses requests from viewers, and rejecting returns the batch to draft", async () => {
    const db = await freshDb();
    const reviewer = await addUser(db, "Rita", "reviewer");
    const viewer = await addUser(db, "Vic", "viewer");
    const admin = await addUser(db, "Ann", "admin");
    const { batchId } = await approvedBatch(db, reviewer);

    await expect(requestApproval(db, { user: viewer, subjectType: "export_batch", subjectId: batchId })).rejects.toThrow(/view/);
    const { approvalId } = await requestApproval(db, { user: reviewer, subjectType: "export_batch", subjectId: batchId });
    expect((await decideApproval(db, config, { user: admin, approvalId, approve: false, note: "Wrong week" })).outcome).toBe("rejected");
    expect(await batchStatus(db, batchId)).toBe("draft");
    await expect(decideApproval(db, config, { user: admin, approvalId, approve: true })).rejects.toThrow(/already been decided/);
    await db.close();
  });

  it("keeps formulas in scraped text from running in a spreadsheet", () => {
    const lead = {
      id: 1,
      business_name: "=HYPERLINK(\"http://evil\")",
      phone_e164: "+19375550101",
      owner_name: "@owner",
      source_name: "s",
      status: "approved",
    } as BatchLead;
    const csv = batchCsv([lead]);
    expect(csv).toContain("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csv).toContain("'@owner");
    expect(csv).toContain(",+19375550101,1,9375550101,");
  });

  it("keeps external writes off unless switched on", () => {
    expect(() => assertExternalWritesEnabled(testConfig())).toThrow(GateError);
    expect(() => assertExternalWritesEnabled(testConfig({ externalWritesEnabled: true }))).not.toThrow();
  });
});

describe("reviewing", () => {
  it("needs a reason to reject and only moves leads that are in the right state", async () => {
    const db = await freshDb();
    const reviewer = await addUser(db, "Rita", "reviewer");
    const { runId } = await importCsv(db, reviewer, `${THREE}Alpha Again,937-555-0101\n`);
    const ids = (await db.query<{ id: number }>("SELECT id FROM leads WHERE run_id = $1 ORDER BY id", [runId])).rows.map((row) => row.id);

    await expect(decideLeads(db, { user: reviewer, leadIds: ids, decision: "reject", reason: " " })).rejects.toThrow(/reason/);
    // The fourth lead is a duplicate and cannot be approved by a bulk action.
    expect(await decideLeads(db, { user: reviewer, leadIds: ids, decision: "approve", reason: null })).toEqual({ changed: 3, skipped: 1 });
    expect(await decideLeads(db, { user: reviewer, leadIds: [ids[0]!], decision: "reject", reason: "Closed down" })).toEqual({ changed: 1, skipped: 0 });
    expect((await leadStatuses(db, runId)).map((lead) => lead.status)).toEqual(["rejected", "approved", "approved", "duplicate"]);

    await expect(markNotDuplicate(db, { user: reviewer, leadId: ids[3]!, reason: "" })).rejects.toThrow(/why/);
    expect(await markNotDuplicate(db, { user: reviewer, leadId: ids[3]!, reason: "Second location" })).toBe("in_review");
    const decisions = await db.query("SELECT 1 FROM audit_decisions");
    expect(decisions.rows).toHaveLength(5);
    await db.close();
  });
});

describe("the delete gate", () => {
  it("deletes an import only after approval and hands its duplicates back to review", async () => {
    const db = await freshDb();
    const reviewer = await addUser(db, "Rita", "reviewer");
    const admin = await addUser(db, "Ann", "admin");
    const first = await importCsv(db, reviewer, "Name,Phone\nAlpha Gym,937-555-0101\n");
    const second = await importCsv(db, reviewer, "Name,Phone\nAlpha Two,937-555-0101\nAlpha Three,937-555-0101\n");
    expect((await leadStatuses(db, second.runId)).map((lead) => lead.status)).toEqual(["duplicate", "duplicate"]);

    const { approvalId } = await requestApproval(db, { user: reviewer, subjectType: "run", subjectId: first.runId });
    expect(await one(db, "SELECT 1 FROM runs WHERE id = $1", [first.runId])).not.toBeNull();

    const result = await decideApproval(db, config, { user: admin, approvalId, approve: true });
    expect(result.message).toBe("Import deleted: 1 lead(s) and 1 raw row(s) removed.");
    expect(await one(db, "SELECT 1 FROM runs WHERE id = $1", [first.runId])).toBeNull();

    const after = await leadStatuses(db, second.runId);
    expect(after.map((lead) => lead.status)).toEqual(["in_review", "duplicate"]);
    expect(after[1]!.reason).toMatch(/^Duplicate of lead #\d+$/);
    await db.close();
  });

  it("will not delete an import whose leads are in an export batch", async () => {
    const db = await freshDb();
    const reviewer = await addUser(db, "Rita", "reviewer");
    const { runId } = await approvedBatch(db, reviewer);
    await expect(requestApproval(db, { user: reviewer, subjectType: "run", subjectId: runId })).rejects.toThrow(/export batch/);
    await db.close();
  });

  it("cancels a delete request when the import changed before it was approved", async () => {
    const db = await freshDb();
    const reviewer = await addUser(db, "Rita", "reviewer");
    const admin = await addUser(db, "Ann", "admin");
    const first = await importCsv(db, reviewer, "Name,Phone\nAlpha Gym,937-555-0101\n");
    const { approvalId } = await requestApproval(db, { user: reviewer, subjectType: "run", subjectId: first.runId });
    await importCsv(db, reviewer, "Name,Phone\nAlpha Two,937-555-0101\n"); // now something depends on it

    const result = await decideApproval(db, config, { user: admin, approvalId, approve: true });
    expect(result.outcome).toBe("void");
    expect(await one(db, "SELECT 1 FROM runs WHERE id = $1", [first.runId])).not.toBeNull();
    await db.close();
  });

  it("deleting a DNC list unblocks only the leads no other list covers", async () => {
    const db = await freshDb();
    const admin = await addUser(db, "Ann", "admin");
    const { runId } = await importCsv(db, admin, THREE);
    const a = await uploadDncList(db, { user: admin, name: "A", fileName: "a.csv", text: "937-555-0101\n937-555-0102\n", defaultCountry: "US" });
    await uploadDncList(db, { user: admin, name: "B", fileName: "b.csv", text: "937-555-0102\n", defaultCountry: "US" });
    expect((await leadStatuses(db, runId)).map((lead) => lead.status)).toEqual(["blocked_dnc", "blocked_dnc", "in_review"]);

    const { approvalId } = await requestApproval(db, { user: admin, subjectType: "dnc_list", subjectId: a.listId });
    const result = await decideApproval(db, config, { user: admin, approvalId, approve: true });
    expect(result.message).toBe('DNC list "A" deleted: 2 number(s) removed.');
    expect((await leadStatuses(db, runId)).map((lead) => lead.status)).toEqual(["in_review", "blocked_dnc", "in_review"]);
    await db.close();
  });
});

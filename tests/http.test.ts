import { describe, expect, it } from "vitest";
import { testConfig } from "../src/config.js";
import type { Db } from "../src/db/db.js";
import { createApp } from "../src/server/app.js";
import { addUser, freshDb } from "./helpers.js";

const HOST = "leads.test";

// A stand-in for one person's browser: keeps the session cookie and the form token.
class Browser {
  cookie = "";
  csrf = "";
  constructor(private readonly app: ReturnType<typeof createApp>) {}

  async get(path: string): Promise<{ status: number; text: string; location: string | null }> {
    const response = await this.app.request(`http://${HOST}${path}`, { headers: { cookie: this.cookie, host: HOST } });
    const text = await response.text();
    const token = text.match(/name="_csrf" value="([^"]+)"/);
    if (token) this.csrf = token[1]!;
    return { status: response.status, text, location: response.headers.get("location") };
  }

  async post(
    path: string,
    fields: Record<string, string | string[] | File>,
    options: { origin?: string; csrf?: string; referer?: string } = {},
  ): Promise<{ status: number; text: string; location: string | null; headers: Headers }> {
    const body = new FormData();
    body.set("_csrf", options.csrf ?? this.csrf);
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) for (const item of value) body.append(key, item);
      else body.set(key, value);
    }
    const response = await this.app.request(`http://${HOST}${path}`, {
      method: "POST",
      body,
      headers: {
        cookie: this.cookie,
        host: HOST,
        origin: options.origin ?? `https://${HOST}`,
        referer: `https://${HOST}${options.referer ?? path}`,
      },
    });
    const set = response.headers.get("set-cookie");
    if (set?.startsWith("le_session=")) this.cookie = set.split(";")[0]!;
    return { status: response.status, text: await response.text(), location: response.headers.get("location"), headers: response.headers };
  }

  async login(name: string): Promise<void> {
    const result = await this.post("/login", { email: `${name}@example.test`, password: "correct horse battery" });
    expect(result.location).toBe("/");
    await this.get("/");
  }
}

async function setup(): Promise<{ db: Db; app: ReturnType<typeof createApp> }> {
  const db = await freshDb();
  await addUser(db, "Ann", "admin");
  await addUser(db, "Rita", "reviewer");
  await addUser(db, "Vic", "viewer");
  return { db, app: createApp({ db, config: testConfig() }) };
}

const message = (location: string | null, kind: "ok" | "err") =>
  new URL(location ?? "/", "http://x").searchParams.get(kind) ?? "";

describe("signing in", () => {
  it("sends anyone without a session to the sign-in page", async () => {
    const { db, app } = await setup();
    const browser = new Browser(app);
    for (const path of ["/", "/leads", "/exports/1", "/audit-log"]) {
      const page = await browser.get(path);
      expect([page.status, page.location]).toEqual([303, "/login"]);
    }
    expect((await browser.post("/leads/decide", { lead: "1", decision: "approve" })).location).toBe("/login");
    expect((await browser.get("/health")).text).toBe('{"ok":true}');

    // A stricter policy makes real browsers post the sign-in form with "Origin: null".
    const page = await app.request(`http://${HOST}/login`, { headers: { host: HOST } });
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect((await browser.post("/login", { email: "x@example.test", password: "x" }, { origin: "null" })).status).toBe(403);
    await db.close();
  });

  it("rejects a wrong password and a deactivated account with the same message", async () => {
    const { db, app } = await setup();
    const browser = new Browser(app);
    const wrong = await browser.post("/login", { email: "rita@example.test", password: "not the password" });
    expect(message(wrong.location, "err")).toBe("That email and password do not match an active account.");

    await db.query("UPDATE users SET active = false WHERE email = 'rita@example.test'");
    const inactive = await browser.post("/login", { email: "rita@example.test", password: "correct horse battery" });
    expect(message(inactive.location, "err")).toBe("That email and password do not match an active account.");
    expect(browser.cookie).toBe("");
    await db.close();
  });

  it("refuses forms from another site and forms without the session token", async () => {
    const { db, app } = await setup();
    const browser = new Browser(app);
    await browser.login("rita");
    expect((await browser.post("/exports", { name: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await browser.post("/exports", { name: "x" }, { csrf: "wrong" })).status).toBe(403);
    await db.close();
  });
});

describe("the whole path through the pages", () => {
  it("takes a file from upload to an approved download, with each role held to its limits", async () => {
    const { db, app } = await setup();
    const rita = new Browser(app);
    const ann = new Browser(app);
    const vic = new Browser(app);
    await rita.login("rita");
    await ann.login("ann");
    await vic.login("vic");

    // Viewer: can look, cannot act. Reviewer: cannot reach admin pages.
    expect((await vic.get("/imports")).text).not.toContain("Upload a file");
    const csv = "Business,Phone Number,Website,City,State\n<b>Alpha</b> Gym,937-555-0101,alpha.com,Dayton,OH\nBeta Spa,937-555-0102,beta.com,Troy,OH\nBeta Again,937-555-0102,,Troy,OH\n";
    const upload = () => new File([csv], "octoparse.csv", { type: "text/csv" });
    expect((await vic.post("/imports", { source: "Octoparse gyms", file: upload() })).status).toBe(403);
    expect((await rita.get("/settings")).status).toBe(403);
    expect((await rita.get("/users")).status).toBe(403);

    // Upload, then confirm the guessed column matching.
    const uploaded = await rita.post("/imports", { source: "Octoparse gyms", file: upload() });
    expect(uploaded.location).toMatch(/^\/imports\/1\?ok=/);
    const mapping = await rita.get("/imports/1");
    expect(mapping.text).toContain("Match the columns");
    expect(mapping.text).toMatch(/<option value="Phone Number" selected(="")?>/);
    const processed = await rita.post("/imports/1/process", {
      business_name: "Business",
      phone: "Phone Number",
      website: "Website",
      city: "City",
      region: "State",
    });
    expect(message(processed.location, "ok")).toBe("Imported 3 rows: 2 to review, 1 duplicate, 0 blocked by DNC, 0 invalid.");

    // Scraped text is shown as text, never as markup, and the missing DNC scrub is said out loud.
    const queue = await rita.get("/leads?status=in_review");
    expect(queue.text).toContain("&lt;b&gt;Alpha&lt;/b&gt; Gym");
    expect(queue.text).not.toContain("<b>Alpha</b>");
    expect(queue.text).toContain("No DNC list is loaded");

    expect((await vic.post("/leads/decide", { lead: ["1", "2"], decision: "approve" })).status).toBe(403);
    const decided = await rita.post("/leads/decide", { lead: ["1", "2", "3"], decision: "approve" }, { referer: "/leads?status=in_review" });
    expect(message(decided.location, "ok")).toBe("2 lead(s) approved. 1 skipped because their current status does not allow it.");

    const created = await rita.post("/exports", { name: "Week 48", target_ref: "VICIdial list 1048" });
    expect(created.location).toMatch(/^\/exports\/1\?ok=/);
    const early = await rita.post("/exports/1/download", {}, { referer: "/exports/1" });
    expect(message(early.location, "err")).toBe("This batch has not been approved yet.");

    await rita.post("/exports/1/request-approval", { note: "First batch" });
    // A reviewer cannot approve, not even their own request.
    expect((await rita.post("/approvals/1/decide", { decision: "approve" })).status).toBe(403);
    expect((await rita.post("/exports/1/download", {}, { referer: "/exports/1" })).status).toBe(303);

    const approvals = await ann.get("/approvals");
    expect(approvals.text).toContain("VICIdial list 1048");
    expect(approvals.text).toContain("Approving this exports leads that have not been scrubbed");
    const approved = await ann.post("/approvals/1/decide", { decision: "approve" });
    expect(message(approved.location, "ok")).toBe("Batch approved. The file can now be downloaded.");

    const download = await rita.post("/exports/1/download", {}, { referer: "/exports/1" });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="lead-engine-1-week-48.csv"');
    expect(download.text.trim().split("\n")).toHaveLength(3);
    expect(download.text).toContain("+19375550102,1,9375550102");

    const log = await ann.get("/audit-log");
    for (const action of ["import.uploaded", "import.processed", "review.approve", "approval.requested", "approval.approved", "export.downloaded"]) {
      expect(log.text).toContain(action);
    }
    await db.close();
  });

  it("lets an admin change the rules and manage accounts, but not remove the last admin", async () => {
    const { db, app } = await setup();
    const ann = new Browser(app);
    await ann.login("ann");

    const saved = await ann.post("/settings", { dedupeKeys: "phone", requiredFields: ["business_name", "phone_e164", "city"], defaultCountry: "us", sharedDomains: "Facebook.com\n\nyelp.com" });
    expect(message(saved.location, "ok")).toContain("Settings saved");
    const stored = await db.query<{ key: string; value: unknown }>("SELECT key, value FROM settings ORDER BY key");
    expect(Object.fromEntries(stored.rows.map((row) => [row.key, row.value]))).toEqual({
      dedupeKeys: ["phone"],
      defaultCountry: "US",
      requiredFields: ["business_name", "phone_e164", "city"],
      sharedDomains: ["facebook.com", "yelp.com"],
    });
    expect(message((await ann.post("/settings", { defaultCountry: "USA" })).location, "err")).toContain("not valid");

    const added = await ann.post("/users", { name: "New Person", email: "new@example.test", role: "reviewer", password: "short" });
    expect(message(added.location, "err")).toBe("Passwords need at least 10 characters.");
    expect(message((await ann.post("/users", { name: "New Person", email: "new@example.test", role: "reviewer", password: "long enough pw" })).location, "ok")).toBe("Account created.");

    const demote = await ann.post("/users/1", { role: "reviewer", active: "yes" }, { referer: "/users" });
    expect(message(demote.location, "err")).toBe("This is the only active admin. Make someone else an admin first.");
    await db.close();
  });
});

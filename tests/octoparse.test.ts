import { describe, expect, it } from "vitest";
import { fetchTaskRows, listTasks, rowsToCsv, type FetchLike } from "../src/adapters/octoparse.js";
import { testConfig } from "../src/config.js";
import { parseCsv } from "../src/pipeline/csv.js";
import { createApp } from "../src/server/app.js";
import { addUser, freshDb } from "./helpers.js";

type Call = { url: string; method: string; key: string | undefined };

// A stand-in for Octoparse. No test reaches the real service.
function fakeOctoparse(rows: Record<string, unknown>[], options: { status?: number } = {}): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", key: init?.headers?.["x-api-key"] });
    const answer = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data, requestId: "r" }) });
    if (options.status) return { ok: false, status: options.status, text: async () => "denied" };
    const path = new URL(url);
    if (path.pathname === "/taskGroup") return answer([{ taskGroupId: "g1", taskGroupName: "Gyms" }]);
    if (path.pathname === "/task/search") return answer([{ taskId: "t1", taskName: "Google Maps gyms Dayton" }]);
    if (path.pathname === "/data/all") {
      const offset = Number(path.searchParams.get("offset"));
      const size = Number(path.searchParams.get("size"));
      return answer({ data: rows.slice(offset, offset + size), total: rows.length, restTotal: 0, offset: 0 });
    }
    return { ok: false, status: 404, text: async () => "" };
  };
  return { fetchImpl, calls };
}

const ROWS = [
  { Title: "Alpha, Gym", Phone: "937-555-0101", Category: "Gym" },
  { Title: "Beta Spa", Phone: "937-555-0102", Website: "beta.com" },
];

describe("the Octoparse client", () => {
  it("lists tasks and reads every page of a task's rows, only ever with GET", async () => {
    const many = Array.from({ length: 1201 }, (_, index) => ({ Title: `Gym ${index}`, Phone: "937-555-0101" }));
    const { fetchImpl, calls } = fakeOctoparse(many);
    expect(await listTasks(fetchImpl, "op_sk_test")).toEqual([{ taskId: "t1", taskName: "Google Maps gyms Dayton", group: "Gyms" }]);
    expect(await fetchTaskRows(fetchImpl, "op_sk_test", "t1", 5000)).toHaveLength(1201);
    expect(calls.every((call) => call.method === "GET" && call.key === "op_sk_test")).toBe(true);
    expect(calls.filter((call) => call.url.includes("/data/all")).map((call) => new URL(call.url).searchParams.get("offset"))).toEqual(["0", "500", "1000"]);
  });

  it("refuses a task that is over the row limit instead of cutting it short", async () => {
    const { fetchImpl } = fakeOctoparse(Array.from({ length: 30 }, () => ({ Title: "x" })));
    await expect(fetchTaskRows(fetchImpl, "k", "t1", 10)).rejects.toThrow("the import limit is 10");
  });

  it("says so when the key is refused", async () => {
    const { fetchImpl } = fakeOctoparse([], { status: 401 });
    await expect(listTasks(fetchImpl, "bad")).rejects.toThrow("refused the API key");
  });

  it("keeps every column, including ones only some rows have", () => {
    const parsed = parseCsv(rowsToCsv(ROWS), 100);
    expect(parsed.headers).toEqual(["Title", "Phone", "Category", "Website"]);
    expect(parsed.rows[0]).toMatchObject({ Title: "Alpha, Gym", Website: "" });
  });
});

describe("pulling from Octoparse through the pages", () => {
  const HOST = "leads.test";
  async function signIn(app: ReturnType<typeof createApp>, name: string): Promise<{ cookie: string; csrf: string }> {
    const body = new FormData();
    body.set("email", `${name}@example.test`);
    body.set("password", "correct horse battery");
    const response = await app.request(`http://${HOST}/login`, { method: "POST", body, headers: { host: HOST, origin: `https://${HOST}` } });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (await app.request(`http://${HOST}/imports`, { headers: { host: HOST, cookie } })).text();
    return { cookie, csrf: page.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "" };
  }
  const pull = (app: ReturnType<typeof createApp>, who: { cookie: string; csrf: string }) => {
    const body = new FormData();
    body.set("_csrf", who.csrf);
    body.set("task_id", "t1");
    body.set("task_name", "Google Maps gyms Dayton");
    return app.request(`http://${HOST}/imports/octoparse`, {
      method: "POST",
      body,
      headers: { host: HOST, cookie: who.cookie, origin: `https://${HOST}`, referer: `https://${HOST}/imports/octoparse` },
    });
  };

  it("says it is not connected when there is no key, and calls nothing", async () => {
    const db = await freshDb();
    await addUser(db, "Rita", "reviewer");
    const { fetchImpl, calls } = fakeOctoparse(ROWS);
    const app = createApp({ db, config: testConfig(), fetchImpl });
    const rita = await signIn(app, "rita");
    const page = await (await app.request(`http://${HOST}/imports/octoparse`, { headers: { host: HOST, cookie: rita.cookie } })).text();
    expect(page).toContain("Octoparse is not connected");
    const refused = await pull(app, rita);
    expect(decodeURIComponent(refused.headers.get("location")!.replace(/\+/g, " "))).toContain("Octoparse is not connected");
    expect(calls).toHaveLength(0);
    await db.close();
  });

  it("brings a task's rows in as an import that still needs its columns matched", async () => {
    const db = await freshDb();
    await addUser(db, "Rita", "reviewer");
    await addUser(db, "Vic", "viewer");
    const { fetchImpl } = fakeOctoparse(ROWS);
    const app = createApp({ db, config: testConfig({ octoparseApiKey: "op_sk_test" }), fetchImpl });
    const rita = await signIn(app, "rita");
    const vic = await signIn(app, "vic");

    const page = await (await app.request(`http://${HOST}/imports/octoparse`, { headers: { host: HOST, cookie: rita.cookie } })).text();
    expect(page).toContain("Google Maps gyms Dayton");
    expect(page).not.toContain("op_sk_test");
    expect((await pull(app, vic)).status).toBe(403);

    const pulled = await pull(app, rita);
    expect(pulled.headers.get("location")).toMatch(/^\/imports\/1\?ok=Pulled\+2\+rows/);
    const run = await db.query<{ status: string; row_count: number; name: string }>(
      "SELECT r.status, r.row_count, s.name FROM runs r JOIN sources s ON s.id = r.source_id",
    );
    expect(run.rows).toEqual([{ status: "needs_mapping", row_count: 2, name: "Octoparse: Google Maps gyms Dayton" }]);
    // Nothing becomes a lead until a person has matched the columns.
    expect((await db.query("SELECT 1 FROM leads")).rows).toHaveLength(0);
    const log = await db.query<{ action: string }>("SELECT action FROM audit_log WHERE action = 'octoparse.pulled'");
    expect(log.rows).toHaveLength(1);
    await db.close();
  });
});

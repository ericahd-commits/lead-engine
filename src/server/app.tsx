import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { getSession, login, logout, SESSION_COOKIE } from "../auth.js";
import { many, one } from "../db/db.js";
import { getDncState } from "../pipeline/dnc.js";
import { getKnownState } from "../pipeline/known.js";
import { clientIp, isUserError, refererPath, str, withMessage, type Ctx, type Deps, type Env, type FormData } from "./http.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerDncRoutes } from "./routes/dnc.js";
import { registerExportRoutes } from "./routes/exports.js";
import { registerImportRoutes } from "./routes/imports.js";
import { registerKnownRoutes } from "./routes/known.js";
import { registerLeadRoutes } from "./routes/leads.js";
import { Chip, count, Flash, Page, render, Shell, when } from "./views.js";

export function createApp(deps: Deps): Hono<Env> {
  const { db, config } = deps;
  const app = new Hono<Env>();

  // "same-origin", not the stricter default "no-referrer": with no-referrer a browser posts forms
  // with "Origin: null" and no Referer, so the app's own forms would fail the cross-site check
  // below and errors could not return to the page they came from.
  app.use(secureHeaders({ referrerPolicy: "same-origin" }));
  app.get("/health", (c) => c.json({ ok: true }));

  app.use(
    bodyLimit({
      maxSize: config.maxUploadBytes + 1024 * 1024,
      onError: (c) => c.redirect(withMessage(refererPath(c as Ctx, "/"), "err", "That file is larger than the upload limit."), 303),
    }),
  );

  // Every POST: the request must come from this site's own pages, and the body is read once here.
  app.use(async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin) {
        let originHost = "";
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = "";
        }
        if (originHost !== c.req.header("host")) throw new HTTPException(403, { message: "Cross-site request refused." });
      }
      c.set("form", (await c.req.parseBody({ all: true })) as FormData);
    }
    await next();
  });

  app.get("/login", async (c) => {
    if (await getSession(db, getCookie(c, SESSION_COOKIE))) return c.redirect("/", 303);
    const users = await one<{ count: number }>(db, "SELECT count(*)::int AS count FROM users");
    return render(
      c,
      <Shell title="Sign in">
        <div class="login">
          <div class="card">
            <h1>Lead Engine</h1>
            <p class="sub">Sign in to continue.</p>
            <Flash c={c} />
            {(users?.count ?? 0) === 0 ? (
              <div class="note warn">
                No accounts exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) and restart the app to create
                the first admin.
              </div>
            ) : null}
            <form method="post" action="/login">
              <p>
                <label for="email">Email</label>
                <input id="email" type="email" name="email" required autofocus autocomplete="username" />
              </p>
              <p>
                <label for="password">Password</label>
                <input id="password" type="password" name="password" required autocomplete="current-password" />
              </p>
              <button class="primary" type="submit">
                Sign in
              </button>
            </form>
          </div>
        </div>
      </Shell>,
    );
  });

  app.post("/login", async (c) => {
    const form = c.get("form");
    const { token } = await login(db, { email: str(form, "email"), password: str(form, "password"), ip: clientIp(c) });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.production,
      path: "/",
      maxAge: 14 * 24 * 60 * 60,
    });
    return c.redirect("/", 303);
  });

  // Everything below needs a signed-in person. POSTs also need that session's form token.
  app.use(async (c, next) => {
    const session = await getSession(db, getCookie(c, SESSION_COOKIE));
    if (!session) return c.redirect("/login", 303);
    c.set("session", session);
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && str(c.get("form"), "_csrf") !== session.csrfToken) {
      throw new HTTPException(403, { message: "This form has expired. Go back, reload the page and try again." });
    }
    await next();
  });

  app.post("/logout", async (c) => {
    await logout(db, c.get("session"));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/login", 303);
  });

  app.get("/", async (c) => {
    const statuses = await many<{ status: string; count: number }>(
      db,
      "SELECT status, count(*)::int AS count FROM leads GROUP BY status",
    );
    const by = new Map(statuses.map((row) => [row.status, row.count]));
    const total = statuses.reduce((sum, row) => sum + row.count, 0);
    const dnc = await getDncState(db);
    const known = await getKnownState(db);
    const notCompared = [known.vici.lists === 0 ? "VICIdial" : "", known.close.lists === 0 ? "Close" : ""].filter(Boolean);
    const pending = await one<{ count: number }>(db, "SELECT count(*)::int AS count FROM approvals WHERE status = 'pending'");
    const unmapped = await one<{ count: number }>(db, "SELECT count(*)::int AS count FROM runs WHERE status = 'needs_mapping'");
    const unchecked = await one<{ count: number }>(
      db,
      `SELECT count(*)::int AS count FROM leads
       WHERE dnc_checked_at IS NULL AND phone_e164 IS NOT NULL AND status IN ('in_review', 'approved')`,
    );
    const runs = await many<{ id: number; source: string; file_name: string | null; status: string; row_count: number; created_at: Date }>(
      db,
      `SELECT r.id, s.name AS source, r.file_name, r.status, r.row_count, r.created_at
       FROM runs r JOIN sources s ON s.id = r.source_id ORDER BY r.id DESC LIMIT 8`,
    );
    const tiles: [string, string, string][] = [
      ["in_review", "Waiting for review", "/leads?status=in_review"],
      ["approved", "Approved, not exported", "/leads?status=approved"],
      ["exported", "Exported", "/leads?status=exported"],
      ["rejected", "Rejected", "/leads?status=rejected"],
      ["duplicate", "Duplicates", "/leads?status=duplicate"],
      ["in_vici", known.vici.lists === 0 ? "Already in VICIdial (not compared)" : "Already in VICIdial", "/leads?status=in_vici"],
      ["in_close", known.close.lists === 0 ? "Already in Close (not compared)" : "Already in Close", "/leads?status=in_close"],
      ["blocked_dnc", "Blocked by DNC", "/leads?status=blocked_dnc"],
      ["invalid", "Invalid rows", "/leads?status=invalid"],
    ];

    return render(
      c,
      <Page c={c} title="Overview" active="home" sub={`${count(total)} leads in the app.`}>
        {dnc.listCount === 0 ? (
          <div class="note warn">
            <b>No DNC list is loaded.</b> Nothing in the app has been checked against a do-not-call list
            {(unchecked?.count ?? 0) > 0 ? `, including ${count(unchecked!.count)} lead(s) in review or approved` : ""}.{" "}
            <a href="/dnc">Upload one</a> before exporting anything for dialing.
          </div>
        ) : null}
        {notCompared.length > 0 ? (
          <div class="note warn">
            <b>No export from {notCompared.join(" or ")} is loaded</b>, so leads are not compared with what is already
            there. <a href="/existing">Upload one</a>
          </div>
        ) : null}
        {(pending?.count ?? 0) > 0 ? (
          <div class="note warn">
            {count(pending!.count)} request(s) are waiting for a decision. <a href="/approvals">Open approvals</a>
          </div>
        ) : null}
        {(unmapped?.count ?? 0) > 0 ? (
          <div class="note warn">
            {count(unmapped!.count)} uploaded file(s) still need their columns matched. <a href="/imports">Open imports</a>
          </div>
        ) : null}
        <div class="grid" style="margin-bottom:18px">
          {tiles.map(([status, label, href]) => (
            <a class="stat" href={href} style="color:inherit">
              <b>{count(by.get(status) ?? 0)}</b>
              <span>{label}</span>
            </a>
          ))}
        </div>
        <div class="card">
          <h2>Latest imports</h2>
          {runs.length === 0 ? (
            <p class="muted">
              Nothing imported yet. <a href="/imports">Upload a CSV</a> to start.
            </p>
          ) : (
            <div class="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Import</th>
                    <th>Source</th>
                    <th>File</th>
                    <th class="num">Rows</th>
                    <th>Status</th>
                    <th>Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr>
                      <td>
                        <a href={`/imports/${run.id}`}>#{run.id}</a>
                      </td>
                      <td>{run.source}</td>
                      <td>{run.file_name}</td>
                      <td class="num">{count(run.row_count)}</td>
                      <td>
                        <Chip value={run.status} />
                      </td>
                      <td>{when(run.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <p class="muted small">
          External writes are {config.externalWritesEnabled ? "ON" : "OFF"}. This build does not connect to Close, VICIdial or
          any paid service: it knows their records only from uploaded files, and exports are CSV files only.
        </p>
      </Page>,
    );
  });

  registerImportRoutes(app, deps);
  registerLeadRoutes(app, deps);
  registerDncRoutes(app, deps);
  registerKnownRoutes(app, deps);
  registerExportRoutes(app, deps);
  registerApprovalRoutes(app, deps);
  registerAdminRoutes(app, deps);

  app.notFound((c) => c.text("Not found.", 404));

  app.onError((error, c) => {
    const ctx = c as Ctx;
    if (isUserError(error)) {
      const fallback = ctx.req.path === "/login" ? "/login" : "/";
      return c.redirect(withMessage(refererPath(ctx, fallback), "err", error.message), 303);
    }
    if (error instanceof HTTPException) return c.text(error.message, error.status);
    console.error(`[error] ${c.req.method} ${c.req.path}`, error);
    return c.text("Something went wrong on our side and the error has been logged. Check the page you came from before trying again.", 500);
  });

  return app;
}

import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { listApprovals } from "../approvals.js";
import { getSession, login, logout, SESSION_COOKIE } from "../auth.js";
import { many, one } from "../db/db.js";
import { getDncState } from "../pipeline/dnc.js";
import { getKnownState } from "../pipeline/known.js";
import { clientIp, isUserError, refererPath, str, withMessage, type Ctx, type Deps, type Env, type FormData } from "./http.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { approvalTitle, registerApprovalRoutes } from "./routes/approvals.js";
import { registerCheckRoutes } from "./routes/checks.js";
import { registerDncRoutes } from "./routes/dnc.js";
import { registerExportRoutes } from "./routes/exports.js";
import { registerImportRoutes } from "./routes/imports.js";
import { registerKnownRoutes } from "./routes/known.js";
import { HELD, NEEDS_INFO, registerLeadRoutes } from "./routes/leads.js";
import { Brand, Chip, count, day, Flash, Page, render, Shell, when } from "./views.js";

const LOGO = new Uint8Array(readFileSync(new URL("./assets/logo.png", import.meta.url)));

export function createApp(deps: Deps): Hono<Env> {
  const { db, config } = deps;
  const app = new Hono<Env>();

  // "same-origin", not the stricter default "no-referrer": with no-referrer a browser posts forms
  // with "Origin: null" and no Referer, so the app's own forms would fail the cross-site check
  // below and errors could not return to the page they came from.
  app.use(secureHeaders({ referrerPolicy: "same-origin" }));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/assets/logo.png", (c) => {
    c.header("Content-Type", "image/png");
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(LOGO);
  });

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
          <Brand />
          <div class="card">
            <form method="post" action="/login">
              <div>
                <h2 style="margin:0">Sign in</h2>
                <span class="muted small">Use the account an admin gave you.</span>
              </div>
              <Flash c={c} inline />
              {(users?.count ?? 0) === 0 ? (
                <div class="note warn">
                  No accounts exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) and restart the app to create
                  the first admin.
                </div>
              ) : null}
              <label>
                Email
                <input id="email" type="email" name="email" required autofocus autocomplete="username" />
              </label>
              <label>
                Password
                <input id="password" type="password" name="password" required autocomplete="current-password" />
              </label>
              <button class="primary lift" type="submit">
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
    const reading = c.req.method === "GET" || c.req.method === "HEAD";
    if (!reading && str(c.get("form"), "_csrf") !== session.csrfToken) {
      throw new HTTPException(403, { message: "This form has expired. Go back, reload the page and try again." });
    }
    const nav = reading
      ? await one<{ pending: number; unmapped: number; in_review: number }>(
          db,
          `SELECT (SELECT count(*)::int FROM approvals WHERE status = 'pending') AS pending,
                  (SELECT count(*)::int FROM runs WHERE status = 'needs_mapping') AS unmapped,
                  (SELECT count(*)::int FROM leads WHERE status = 'in_review') AS in_review`,
        )
      : null;
    c.set("nav", {
      pending: nav?.pending ?? 0,
      unmapped: nav?.unmapped ?? 0,
      inReview: nav?.in_review ?? 0,
      externalWrites: config.externalWritesEnabled,
    });
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
    const by = (status: string) => statuses.find((row) => row.status === status)?.count ?? 0;
    const total = statuses.reduce((sum, row) => sum + row.count, 0);
    const held = HELD.reduce((sum, status) => sum + by(status), 0);
    const needsInfo =
      (await one<{ count: number }>(db, `SELECT count(*)::int AS count FROM leads l WHERE l.status = 'in_review' AND ${NEEDS_INFO}`))?.count ?? 0;
    const dnc = await getDncState(db);
    const known = await getKnownState(db);
    const notCompared = [known.vici.lists === 0 ? "VICIdial" : "", known.close.lists === 0 ? "Close" : ""].filter(Boolean);
    const pending = (await listApprovals(db, 200)).filter((item) => item.status === "pending");
    const unmapped = await many<{ id: number; file_name: string | null; row_count: number }>(
      db,
      "SELECT id, file_name, row_count FROM runs WHERE status = 'needs_mapping' ORDER BY id DESC LIMIT 5",
    );
    const unchecked =
      (
        await one<{ count: number }>(
          db,
          `SELECT count(*)::int AS count FROM leads
           WHERE dnc_checked_at IS NULL AND phone_e164 IS NOT NULL AND status IN ('in_review', 'approved')`,
        )
      )?.count ?? 0;
    const files = await one<{ count: number; latest: Date | null }>(db, "SELECT count(*)::int AS count, max(created_at) AS latest FROM runs");
    const runs = await many<{ id: number; source: string; file_name: string | null; status: string; row_count: number; created_at: Date }>(
      db,
      `SELECT r.id, s.name AS source, r.file_name, r.status, r.row_count, r.created_at
       FROM runs r JOIN sources s ON s.id = r.source_id ORDER BY r.id DESC LIMIT 5`,
    );
    const empty = total === 0 && (files?.count ?? 0) === 0;

    const needs: { tone: string; title: string; body: string; action: string; href: string }[] = [];
    if (dnc.listCount === 0) {
      needs.push({
        tone: "warn",
        title: "No DNC list is loaded",
        body: `Nothing in the app has been checked against a do-not-call list${unchecked > 0 ? `, including ${count(unchecked)} lead(s) in review or approved` : ""}. Load one before exporting anything for dialing.`,
        action: "Load a list",
        href: "/checks",
      });
    }
    if (pending.length > 0) {
      needs.push({
        tone: "warn",
        title: `${count(pending.length)} request(s) waiting for a decision`,
        body: pending.slice(0, 4).map(approvalTitle).join(" · ") + (pending.length > 4 ? ` · and ${count(pending.length - 4)} more` : ""),
        action: "Open approvals",
        href: "/approvals",
      });
    }
    for (const run of unmapped) {
      needs.push({
        tone: "primary",
        title: `Import #${run.id} needs its columns matched`,
        body: `${run.file_name ?? "file"} · ${count(run.row_count)} rows. No leads are created until this is done.`,
        action: "Match columns",
        href: `/imports/${run.id}`,
      });
    }
    if (by("in_review") > 0) {
      needs.push({
        tone: "primary",
        title: `${count(by("in_review"))} lead(s) waiting for review`,
        body: needsInfo > 0 ? `${count(needsInfo)} of them are marked as needing info.` : "They passed the automatic checks and need a person to decide.",
        action: "Start reviewing",
        href: "/leads",
      });
    }
    if (notCompared.length > 0) {
      needs.push({
        tone: "",
        title: `Leads are not compared with ${notCompared.join(" or ")}`,
        body: `No export from ${notCompared.join(" or ")} is loaded, so leads already there are not held back.`,
        action: "Upload export",
        href: "/checks",
      });
    }

    const stages: { step: string; n: number; label: string; sub: string; href: string }[] = [
      { step: "Imported", n: total, label: "All leads", sub: `From ${count(files?.count ?? 0)} file(s)`, href: "/leads?tab=all" },
      { step: "Held back", n: held, label: "Not sent to review", sub: "Duplicates, already in VICIdial or Close, DNC, invalid", href: "/leads?tab=held" },
      { step: "Step 3", n: by("in_review"), label: "In review", sub: `${count(needsInfo)} need info · ${count(by("rejected"))} rejected so far`, href: "/leads" },
      { step: "Step 4", n: by("approved"), label: "Approved", sub: "Not exported yet", href: "/exports" },
      { step: "Done", n: by("exported"), label: "Exported", sub: "Downloaded as CSV", href: "/leads?status=exported" },
    ];

    return render(
      c,
      <Page
        c={c}
        title="Overview"
        active="home"
        sub={empty ? "No leads yet." : `${count(total)} lead(s) in the app.${files?.latest ? ` Last file uploaded ${day(files.latest)}.` : ""}`}
      >
        {empty ? (
          <div class="card" style="padding:32px;display:grid;gap:20px">
            <div style="display:grid;gap:4px;max-width:560px">
              <h2 style="margin:0;font-size:18px">Let's get your first leads in</h2>
              <p class="muted">Three steps. Nothing leaves the app until an admin approves it.</p>
            </div>
            <div class="onb">
              <div>
                <span class="eyebrow">Step 1</span>
                <strong>Upload a scraped CSV</strong>
                <span class="muted small">Match its columns and the rows become leads.</span>
              </div>
              <div>
                <span class="eyebrow">Step 2</span>
                <strong>Load your checks</strong>
                <span class="muted small">A DNC list and exports from VICIdial and Close. None is loaded yet.</span>
              </div>
              <div>
                <span class="eyebrow">Step 3</span>
                <strong>Review and export</strong>
                <span class="muted small">Approve leads, batch them, get sign-off.</span>
              </div>
            </div>
            <div>
              <a class="btn primary lift" href="/imports">
                Upload a CSV
              </a>
            </div>
          </div>
        ) : (
          <>
            <div class="card flush">
              <div class="card-h">
                <h2>Needs you</h2>
                <span class="muted small">{needs.length > 0 ? `${count(needs.length)} thing(s)` : "All caught up"}</span>
              </div>
              {needs.length === 0 ? <div class="need muted">Nothing is waiting on a person right now.</div> : null}
              {needs.map((need) => (
                <div class="need">
                  <span class={`dot ${need.tone}`}></span>
                  <div class="t">
                    <strong>{need.title}</strong>
                    <span class="muted small">{need.body}</span>
                  </div>
                  <a class="btn sm" href={need.href}>
                    {need.action}
                  </a>
                </div>
              ))}
            </div>

            <div class="stack tight">
              <div class="card-h" style="padding:0">
                <h2>Where your leads are</h2>
                <span class="muted small">Click a stage to open it</span>
              </div>
              <div class="grid">
                {stages.map((stage) => (
                  <a class="stat" href={stage.href}>
                    <span class="eyebrow soft">{stage.step}</span>
                    <b>{count(stage.n)}</b>
                    <strong>{stage.label}</strong>
                    <span>{stage.sub}</span>
                  </a>
                ))}
              </div>
            </div>

            <div class="card flush">
              <div class="card-h">
                <h2>Latest imports</h2>
                <a class="small" href="/imports" style="font-weight:600">
                  All imports
                </a>
              </div>
              {runs.length === 0 ? <div class="empty">No files have been uploaded yet.</div> : null}
              <div class="lines">
                {runs.map((run) => (
                  <div class="runline">
                    <a href={`/imports/${run.id}`}>#{run.id}</a>
                    <span style="display:grid;min-width:0">
                      <span class="clip" style="font-weight:600">
                        {run.file_name ?? "file"}
                      </span>
                      <span class="muted tiny clip">{run.source}</span>
                    </span>
                    <span class="muted">{count(run.row_count)} rows</span>
                    <span>
                      <Chip value={run.status} href={`/imports/${run.id}`} />
                    </span>
                    <span class="muted">{when(run.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </Page>,
    );
  });

  registerImportRoutes(app, deps);
  registerLeadRoutes(app, deps);
  registerCheckRoutes(app, deps);
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

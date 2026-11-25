import { changeOwnPassword, createUser, listUsers, ROLES, updateUser } from "../../auth.js";
import { logAudit } from "../../audit.js";
import { many, one } from "../../db/db.js";
import { DEDUPE_KEYS, loadSettings, REQUIRABLE_FIELDS, saveSettings, type Settings } from "../../settings.js";
import { idParam, list, need, ok, str, type App, type Deps } from "../http.js";
import { Avatar, count, Csrf, Page, Pager, render, when } from "../views.js";

const KEY_HELP: Record<string, string> = {
  phone: "Same phone number",
  domain: "Same website (shared sites like facebook.com are ignored)",
  name_city: "Same business name in the same city",
};

export function registerAdminRoutes(app: App, { db, config }: Deps): void {
  app.get("/audit-log", async (c) => {
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const size = 100;
    const total = (await one<{ count: number }>(db, "SELECT count(*)::int AS count FROM audit_log"))?.count ?? 0;
    const pages = Math.max(1, Math.ceil(total / size));
    const rows = await many<{ id: number; actor: string; action: string; subject: string | null; details_json: Record<string, unknown>; at: Date }>(
      db,
      `SELECT id, actor, action, subject, details_json, at FROM audit_log ORDER BY id DESC LIMIT ${size} OFFSET ${(Math.min(page, pages) - 1) * size}`,
    );
    const shownPage = Math.min(page, pages);
    return render(
      c,
      <Page c={c} title="Audit log" active="audit" sub="Everything anyone did in the app, newest first. Entries are never edited or removed.">
        <div class="card flush">
          {rows.length === 0 ? <div class="empty">Nothing has been recorded yet.</div> : null}
          {rows.map((row, index) => {
            const details = JSON.stringify(row.details_json);
            return (
              <div class="arow" style={index === 0 ? "border-top:none" : ""}>
                <span class="muted">{when(row.at)}</span>
                <strong>{row.actor.replace(/^user:\d+ /, "")}</strong>
                <span style="display:grid;gap:2px;min-width:0">
                  <span>
                    <span class="mono" style="color:var(--ink)">
                      {row.action}
                    </span>
                    {row.subject ? <span class="mono"> · {row.subject}</span> : null}
                  </span>
                  {details === "{}" ? null : <span class="mono">{details.length > 400 ? `${details.slice(0, 400)}…` : details}</span>}
                </span>
              </div>
            );
          })}
          <Pager
            page={shownPage}
            pages={pages}
            total={total}
            shown={rows.length}
            size={size}
            href={(target) => (target > 1 ? `/audit-log?page=${target}` : "/audit-log")}
            noun="entries"
          />
        </div>
      </Page>,
    );
  });

  app.get("/settings", async (c) => {
    const session = need(c, "admin");
    const settings = await loadSettings(db);
    const users = await listUsers(db);
    return render(
      c,
      <Page c={c} title="Settings" active="settings" sub="The rules the import uses, and who can sign in. Rules apply to files imported from now on, not to leads already in the app.">
        <div class="note warn">
          These are starting values, not confirmed business rules. The real lead criteria and duplicate rules are still open
          questions for James and Ericah.
        </div>
        <form method="post" action="/settings" class="card flush">
          <Csrf session={session} />
          <div class="pad" style="display:grid;gap:20px">
            <div style="display:grid;gap:8px">
              <h2 style="margin:0">Two leads are the same when they share</h2>
              {DEDUPE_KEYS.map((key) => (
                <label class="check">
                  <input type="checkbox" name="dedupeKeys" value={key} checked={settings.dedupeKeys.includes(key)} /> {KEY_HELP[key]}
                </label>
              ))}
            </div>
            <div style="display:grid;gap:8px">
              <h2 style="margin:0">A row is a valid lead only if it has</h2>
              <div class="grid" style="gap:8px">
                {REQUIRABLE_FIELDS.map((field) => (
                  <label class="check" style="text-transform:capitalize">
                    <input type="checkbox" name="requiredFields" value={field} checked={settings.requiredFields.includes(field)} />{" "}
                    {field.replace("phone_e164", "valid phone").replace("website_domain", "website").replace(/_/g, " ")}
                  </label>
                ))}
              </div>
            </div>
            <label style="max-width:280px">
              Country for numbers with no country code
              <input id="country" type="text" name="defaultCountry" value={settings.defaultCountry} maxlength={2} required />
            </label>
            <label>
              Shared websites (one per line). A match on these never counts as a duplicate.
              <textarea id="shared" name="sharedDomains" rows={8}>
                {settings.sharedDomains.join("\n")}
              </textarea>
            </label>
          </div>
          <div class="card-f">
            <span class="fill muted small">Saved rules apply to the next import.</span>
            <button class="primary" type="submit">
              Save settings
            </button>
          </div>
        </form>
        <div class="card">
          <h2>Set on the server</h2>
          <p class="muted small">These come from environment variables and cannot be changed from this page.</p>
          <dl class="kv">
            <dt>External writes</dt>
            <dd>{config.externalWritesEnabled ? "ON" : "OFF"} (no outside system is connected in this build)</dd>
            <dt>Two-person approval</dt>
            <dd>{config.requireSecondApprover ? "ON: the requester cannot approve their own request" : "OFF: an admin may approve their own request"}</dd>
            <dt>Upload limit</dt>
            <dd>
              {Math.round(config.maxUploadBytes / 1024 / 1024)} MB, {count(config.maxImportRows)} rows per file
            </dd>
          </dl>
        </div>
        <div class="card flush" id="users">
          <div class="card-h">
            <h2>Users</h2>
            <span class="muted small">Admins approve exports and deletes. Reviewers import and review. Viewers can only look.</span>
          </div>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Active</th>
                  <th>New password (optional)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr>
                    <td>
                      <div style="display:flex;gap:10px;align-items:center">
                        <Avatar name={user.name} small />
                        <div>
                          <strong>{user.name}</strong>
                          <div class="tiny muted">
                            {user.email} · since {when(user.created_at)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <select name="role" form={`user-${user.id}`} aria-label={`Role for ${user.name}`} style="min-width:110px">
                        {ROLES.map((role) => (
                          <option value={role} selected={role === user.role}>
                            {role}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input type="checkbox" name="active" value="yes" checked={user.active} form={`user-${user.id}`} aria-label={`${user.name} is active`} />
                    </td>
                    <td>
                      <input type="text" name="password" form={`user-${user.id}`} autocomplete="off" aria-label={`New password for ${user.name}`} style="min-width:160px" />
                    </td>
                    <td>
                      <form method="post" action={`/users/${user.id}`} id={`user-${user.id}`}>
                        <Csrf session={session} />
                        <button class="sm" type="submit">
                          Save
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form method="post" action="/users" class="sec soft" style="border-top:1px solid var(--line)">
            <Csrf session={session} />
            <strong class="small">Add a person</strong>
            <div class="row">
              <label>
                Name
                <input id="name" type="text" name="name" required />
              </label>
              <label>
                Email
                <input id="email" type="email" name="email" required />
              </label>
              <label>
                Role
                <select id="role" name="role">
                  {ROLES.map((role) => (
                    <option value={role} selected={role === "reviewer"}>
                      {role}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Starting password (10+ characters)
                <input id="password" type="text" name="password" required minlength={10} autocomplete="off" />
              </label>
              <div class="fit">
                <button class="primary" type="submit">
                  Add
                </button>
              </div>
            </div>
            <span class="muted tiny">Pass the password on yourself; the app does not send email. They can change it under their name, top right.</span>
          </form>
        </div>
      </Page>,
    );
  });

  app.post("/settings", async (c) => {
    const session = need(c, "admin");
    const form = c.get("form");
    const next = {
      dedupeKeys: list(form, "dedupeKeys"),
      requiredFields: list(form, "requiredFields"),
      defaultCountry: str(form, "defaultCountry"),
      sharedDomains: str(form, "sharedDomains").split(/\r?\n/),
    } as unknown as Settings;
    let saved: Settings;
    try {
      saved = await saveSettings(db, next, session.user.id);
    } catch {
      return c.redirect("/settings?err=Those+settings+are+not+valid.+The+country+must+be+a+two-letter+code+such+as+US.", 303);
    }
    await logAudit(db, session.user, "settings.changed", null, saved);
    return ok(c, "/settings", "Settings saved. They apply to the next import.");
  });

  // Users live on the Settings screen; the old address still works for admins.
  app.get("/users", (c) => {
    need(c, "admin");
    return c.redirect("/settings#users", 303);
  });

  app.post("/users", async (c) => {
    const session = need(c, "admin");
    const form = c.get("form");
    await createUser(db, session.user, {
      email: str(form, "email"),
      name: str(form, "name"),
      role: str(form, "role"),
      password: str(form, "password"),
    });
    return ok(c, "/settings", "Account created.");
  });

  app.post("/users/:id", async (c) => {
    const session = need(c, "admin");
    const form = c.get("form");
    await updateUser(db, session.user, {
      userId: idParam(c),
      role: str(form, "role"),
      active: str(form, "active") === "yes",
      password: str(form, "password") || null,
    });
    return ok(c, "/settings", "Account updated.");
  });

  app.get("/account", (c) => {
    const session = c.get("session");
    return render(
      c,
      <Page c={c} title="Your account" active="" sub={`${session.user.name} · ${session.user.email} · ${session.user.role}`}>
        <form method="post" action="/account/password" class="card" style="max-width:460px">
          <Csrf session={session} />
          <h2>Change password</h2>
          <p>
            <label for="current">Current password</label>
            <input id="current" type="password" name="current" required autocomplete="current-password" />
          </p>
          <p>
            <label for="next">New password (10+ characters)</label>
            <input id="next" type="password" name="next" required minlength={10} autocomplete="new-password" />
          </p>
          <button class="primary" type="submit">
            Change password
          </button>
        </form>
      </Page>,
    );
  });

  app.post("/account/password", async (c) => {
    const form = c.get("form");
    await changeOwnPassword(db, c.get("session"), str(form, "current"), str(form, "next"));
    return ok(c, "/account", "Password changed. Other browsers signed in to your account were signed out.");
  });
}

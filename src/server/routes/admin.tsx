import { changeOwnPassword, createUser, listUsers, ROLES, updateUser } from "../../auth.js";
import { logAudit } from "../../audit.js";
import { many, one } from "../../db/db.js";
import { DEDUPE_KEYS, loadSettings, REQUIRABLE_FIELDS, saveSettings, type Settings } from "../../settings.js";
import { idParam, list, need, ok, str, type App, type Deps } from "../http.js";
import { count, Csrf, Page, Pager, render, when } from "../views.js";

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
    return render(
      c,
      <Page c={c} title="Audit log" active="audit" sub="Everything anyone did in the app, newest first. Entries are never edited or removed.">
        <div class="card">
          <div class="scroll">
            <table class="small">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>On</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const details = JSON.stringify(row.details_json);
                  return (
                    <tr>
                      <td style="white-space:nowrap">{when(row.at)}</td>
                      <td>{row.actor.replace(/^user:\d+ /, "")}</td>
                      <td class="mono">{row.action}</td>
                      <td class="mono">{row.subject}</td>
                      <td class="mono" style="overflow-wrap:anywhere">
                        {details === "{}" ? "" : details.length > 400 ? `${details.slice(0, 400)}…` : details}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={Math.min(page, pages)} pages={pages} total={total} href={(target) => (target > 1 ? `/audit-log?page=${target}` : "/audit-log")} noun="entries" />
        </div>
      </Page>,
    );
  });

  app.get("/settings", async (c) => {
    const session = need(c, "admin");
    const settings = await loadSettings(db);
    return render(
      c,
      <Page c={c} title="Settings" active="settings" sub="The rules the import uses. They apply to files imported from now on, not to leads already in the app.">
        <div class="note warn small">
          These are starting values, not confirmed business rules. The real lead criteria and duplicate rules are still open
          questions for James and Ericah.
        </div>
        <form method="post" action="/settings" class="card">
          <Csrf session={session} />
          <h2>Two leads are the same when they share</h2>
          {DEDUPE_KEYS.map((key) => (
            <p style="margin:4px 0">
              <label style="font-weight:400">
                <input type="checkbox" name="dedupeKeys" value={key} checked={settings.dedupeKeys.includes(key)} /> {KEY_HELP[key]}
              </label>
            </p>
          ))}
          <h2 style="margin-top:20px">A row is a valid lead only if it has</h2>
          <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:4px">
            {REQUIRABLE_FIELDS.map((field) => (
              <label style="font-weight:400">
                <input type="checkbox" name="requiredFields" value={field} checked={settings.requiredFields.includes(field)} />{" "}
                {field.replace("phone_e164", "valid phone").replace("website_domain", "website").replace(/_/g, " ")}
              </label>
            ))}
          </div>
          <div class="row" style="margin-top:20px">
            <div style="max-width:240px">
              <label for="country">Country for numbers with no country code</label>
              <input id="country" type="text" name="defaultCountry" value={settings.defaultCountry} maxlength={2} required />
            </div>
          </div>
          <p style="margin-top:20px">
            <label for="shared">Shared websites (one per line). A match on these never counts as a duplicate.</label>
            <textarea id="shared" name="sharedDomains" rows={8}>
              {settings.sharedDomains.join("\n")}
            </textarea>
          </p>
          <button class="primary" type="submit">
            Save settings
          </button>
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

  app.get("/users", async (c) => {
    const session = need(c, "admin");
    const users = await listUsers(db);
    return render(
      c,
      <Page c={c} title="Users" active="users" sub="Admins approve exports and deletes. Reviewers import and review. Viewers can only look.">
        <div class="card">
          <h2>Add a person</h2>
          <form method="post" action="/users">
            <Csrf session={session} />
            <div class="row">
              <div>
                <label for="name">Name</label>
                <input id="name" type="text" name="name" required />
              </div>
              <div>
                <label for="email">Email</label>
                <input id="email" type="email" name="email" required />
              </div>
              <div>
                <label for="role">Role</label>
                <select id="role" name="role">
                  {ROLES.map((role) => (
                    <option value={role} selected={role === "reviewer"}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="password">Starting password (10+ characters)</label>
                <input id="password" type="text" name="password" required minlength={10} autocomplete="off" />
              </div>
              <div class="fit">
                <button class="primary" type="submit">
                  Add
                </button>
              </div>
            </div>
            <p class="muted small">Pass the password on yourself; the app does not send email. They can change it under their name, top right.</p>
          </form>
        </div>
        <div class="card">
          <h2>Accounts</h2>
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
                      {user.name}
                      <div class="small muted">
                        {user.email} · since {when(user.created_at)}
                      </div>
                    </td>
                    <td>
                      <select name="role" form={`user-${user.id}`} aria-label={`Role for ${user.name}`}>
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
                      <input type="text" name="password" form={`user-${user.id}`} autocomplete="off" aria-label={`New password for ${user.name}`} />
                    </td>
                    <td>
                      <form method="post" action={`/users/${user.id}`} id={`user-${user.id}`}>
                        <Csrf session={session} />
                        <button type="submit">Save</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Page>,
    );
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
    return ok(c, "/users", "Account created.");
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
    return ok(c, "/users", "Account updated.");
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

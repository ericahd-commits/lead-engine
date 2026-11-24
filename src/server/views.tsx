import { html } from "hono/html";
import type { Child, FC } from "hono/jsx";
import type { Session } from "../auth.js";
import { can, type Ctx } from "./http.js";

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#16202c;--muted:#5d6b7a;--line:#dfe4ea;--brand:#1f5fd0;--ok:#1d7a46;--okbg:#e5f5ec;
--warn:#8a5a00;--warnbg:#fff3d6;--bad:#a8261d;--badbg:#fde9e7;--chip:#eef1f5}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
header.top{background:#16202c;color:#fff}
header.top .in{max-width:1240px;margin:0 auto;padding:0 20px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
header.top .name{font-weight:700;padding:14px 0;color:#fff}
header.top nav{display:flex;gap:2px;flex-wrap:wrap;flex:1}
header.top nav a{color:#c5d0dc;padding:14px 10px;border-bottom:3px solid transparent}
header.top nav a.on{color:#fff;border-bottom-color:#6ea3ff}
header.top nav a:hover{color:#fff;text-decoration:none}
header.top .who{color:#c5d0dc;font-size:13px;display:flex;gap:10px;align-items:center}
header.top .who button{background:none;border:1px solid #47566a;color:#c5d0dc;padding:4px 10px}
main{max-width:1240px;margin:0 auto;padding:22px 20px 60px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:0 0 10px}
.sub{color:var(--muted);margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:18px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.stat b{display:block;font-size:26px;line-height:1.2}.stat span{color:var(--muted);font-size:13px}
.note{border-radius:8px;padding:11px 14px;margin-bottom:16px;border:1px solid}
.note.ok{background:var(--okbg);border-color:#b5dcc4;color:var(--ok)}
.note.err{background:var(--badbg);border-color:#f0bdb8;color:var(--bad)}
.note.warn{background:var(--warnbg);border-color:#ecd28f;color:var(--warn)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);white-space:nowrap}
td.num,th.num{text-align:right}
.chip{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600;background:var(--chip);white-space:nowrap}
.chip.approved,.chip.done,.chip.exported,.chip.used{background:var(--okbg);color:var(--ok)}
.chip.in_review,.chip.awaiting_approval,.chip.pending,.chip.needs_mapping,.chip.draft{background:var(--warnbg);color:var(--warn)}
.chip.rejected,.chip.blocked_dnc,.chip.failed,.chip.invalid{background:var(--badbg);color:var(--bad)}
label{display:block;font-weight:600;font-size:13px;margin-bottom:4px}
input[type=text],input[type=email],input[type=password],input[type=search],select,textarea{width:100%;padding:8px 10px;border:1px solid #c3ccd6;border-radius:7px;font:inherit;background:#fff}
input[type=file]{font:inherit}
textarea{min-height:90px}
button,.btn{font:inherit;padding:8px 14px;border-radius:7px;border:1px solid #c3ccd6;background:#fff;color:var(--ink);cursor:pointer;display:inline-block}
button.primary,.btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}
button.danger{background:#fff;border-color:#e0a49f;color:var(--bad)}
button.good{background:var(--ok);border-color:var(--ok);color:#fff}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}.row>div{flex:1;min-width:170px}.row>.fit{flex:0 0 auto;min-width:0}
.muted{color:var(--muted)}.small{font-size:13px}.mono{font-family:ui-monospace,Consolas,monospace;font-size:13px}
dl.kv{display:grid;grid-template-columns:minmax(140px,220px) 1fr;gap:6px 16px;margin:0}
dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;overflow-wrap:anywhere}
.pager{display:flex;gap:12px;align-items:center;margin-top:14px}
form.inline{display:inline}
.login{max-width:380px;margin:9vh auto;padding:0 16px}
@media(max-width:640px){dl.kv{grid-template-columns:1fr}dl.kv dt{margin-top:6px}}
`;

const NAV: { href: string; label: string; key: string; admin?: boolean }[] = [
  { href: "/", label: "Overview", key: "home" },
  { href: "/imports", label: "Imports", key: "imports" },
  { href: "/leads?status=in_review", label: "Review queue", key: "review" },
  { href: "/leads", label: "All leads", key: "leads" },
  { href: "/dnc", label: "DNC", key: "dnc" },
  { href: "/exports", label: "Exports", key: "exports" },
  { href: "/approvals", label: "Approvals", key: "approvals" },
  { href: "/audit-log", label: "Audit log", key: "audit" },
  { href: "/settings", label: "Settings", key: "settings", admin: true },
  { href: "/users", label: "Users", key: "users", admin: true },
];

export const Csrf: FC<{ session: Session }> = ({ session }) => <input type="hidden" name="_csrf" value={session.csrfToken} />;

export const Shell: FC<{ title: string; children?: Child }> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{title} · Lead Engine</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>{children}</body>
  </html>
);

export const Flash: FC<{ c: Ctx }> = ({ c }) => {
  const okText = c.req.query("ok");
  const errText = c.req.query("err");
  return (
    <>
      {okText ? <div class="note ok">{okText}</div> : null}
      {errText ? <div class="note err">{errText}</div> : null}
    </>
  );
};

export const Page: FC<{ c: Ctx; title: string; active: string; sub?: string; children?: Child }> = ({
  c,
  title,
  active,
  sub,
  children,
}) => {
  const session = c.get("session");
  return (
    <Shell title={title}>
      <header class="top">
        <div class="in">
          <a class="name" href="/">
            Lead Engine
          </a>
          <nav>
            {NAV.filter((item) => !item.admin || can(session, "admin")).map((item) => (
              <a href={item.href} class={item.key === active ? "on" : ""}>
                {item.label}
              </a>
            ))}
          </nav>
          <div class="who">
            <a href="/account" style="color:#c5d0dc">
              {session.user.name} ({session.user.role})
            </a>
            <form method="post" action="/logout" class="inline">
              <Csrf session={session} />
              <button type="submit">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main>
        <h1>{title}</h1>
        <p class="sub">{sub ?? ""}</p>
        <Flash c={c} />
        {children}
      </main>
    </Shell>
  );
};

export const Chip: FC<{ value: string }> = ({ value }) => <span class={`chip ${value}`}>{value.replace(/_/g, " ")}</span>;

export function when(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

export const count = (value: number) => value.toLocaleString("en-US");

export const Pager: FC<{ page: number; pages: number; total: number; href: (page: number) => string; noun: string }> = ({
  page,
  pages,
  total,
  href,
  noun,
}) => (
  <div class="pager small">
    <span class="muted">
      {count(total)} {noun}
      {pages > 1 ? ` · page ${page} of ${pages}` : ""}
    </span>
    {page > 1 ? <a href={href(page - 1)}>← Previous</a> : null}
    {page < pages ? <a href={href(page + 1)}>Next →</a> : null}
  </div>
);

const ESTIMATE_LABELS: Record<string, string> = {
  batch: "Batch",
  target: "Goes to",
  targetRef: "Destination note",
  leads: "Leads",
  dncLists: "DNC lists loaded",
  dncNeverLoaded: "DNC scrub",
  cost: "Cost",
  source: "Source",
  fileName: "File",
  rawRecords: "Raw rows",
  inExportBatches: "Leads in export batches",
  duplicatesPointingHere: "Duplicates elsewhere that return to review",
  name: "List",
  numbers: "Numbers",
  leadsUnblocked: "Leads that stop being blocked",
  canBeUndone: "Can be undone",
};

function estimateValue(key: string, value: unknown): string {
  if (key === "dncNeverLoaded") return value ? "NOT DONE. No DNC list is loaded." : "Checked against the loaded lists";
  if (key === "target" && value === "csv") return "CSV file download";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "number" ? count(value) : String(value);
}

// What an approval request covers, as the approver should see it.
export const Estimate: FC<{ data: Record<string, unknown> }> = ({ data }) => (
  <dl class="kv small">
    {Object.entries(data)
      .filter(([key]) => ESTIMATE_LABELS[key])
      .map(([key, value]) => (
        <>
          <dt>{ESTIMATE_LABELS[key]}</dt>
          <dd>{estimateValue(key, value)}</dd>
        </>
      ))}
  </dl>
);

export function render(c: Ctx, page: unknown): Response | Promise<Response> {
  return c.html(html`<!doctype html>${page}`);
}

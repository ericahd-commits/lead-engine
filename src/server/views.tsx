import { html } from "hono/html";
import type { Child, FC } from "hono/jsx";
import type { Session } from "../auth.js";
import { can, type Ctx } from "./http.js";

// The Referrizer design system: colours, type and radii come from its tokens. Red Hat Text is the
// product typeface and Overpass the display one.
const FONTS =
  "https://fonts.googleapis.com/css2?family=Overpass:wght@700&family=Red+Hat+Text:wght@400;500;600;700&display=swap";

const CSS = `
:root{--primary:#4C70F0;--primary-100:#E8EBFF;--primary-600:#3F62DE;--primary-700:#3E4C7D;--bg:#EFF0F7;--soft:#F7F8FC;
--card:#fff;--line:#DDE1EC;--line-strong:#C8CFDF;--hair:rgba(35,40,60,.06);--ink:#23283C;--muted:#6D7287;--softink:#8A91A8;
--ok:#1E7A5E;--okbg:#E6F7F1;--warn:#8A5200;--warnbg:#FFF4E5;--bad:#B4232C;--badbg:#FDE8EA;--info:#16707C;--infobg:#E3F6F9;
--chip:#EEF0F6;--chipink:#4A5068;--font:"Red Hat Text","Segoe UI",Roboto,Arial,sans-serif;
--display:"Overpass","Red Hat Text","Segoe UI",Roboto,Arial,sans-serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--shadow-sm:0 1px 2px rgba(16,23,39,.06);--shadow-md:0 12px 30px rgba(16,23,39,.08);--shadow-primary:0 12px 30px rgba(76,112,240,.22)}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--ink);font:14px/22px var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--primary);text-decoration:none}a:hover{color:var(--primary-600)}
input,select,button,textarea{font-family:inherit}
@keyframes rzFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

.app{display:flex;min-height:100vh}
.side{width:244px;flex:0 0 244px;background:linear-gradient(180deg,#23283C 0%,#2E344B 100%);color:#B3BBD2;padding:20px 16px;
display:flex;flex-direction:column;gap:6px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:12px;padding:0 4px 18px;color:#fff}
.brand img{width:36px;height:36px;border-radius:10px;object-fit:cover;background:var(--primary)}
.brand span{display:grid;line-height:18px}
.brand b{font-family:var(--display);font-weight:700;font-size:15px;color:#fff}
.brand small{font-size:11px;color:rgba(255,255,255,.55)}
.side .group{padding:16px 10px 6px;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.5)}
.side a.item{display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:10px;font-size:13px;font-weight:500;color:#B3BBD2;transition:all 160ms ease}
.side a.item:hover{color:#fff}
.side a.item.on{color:#fff;background:rgba(76,112,240,.22);box-shadow:inset 0 0 0 1px rgba(110,140,255,.18)}
.side .tile{width:26px;height:26px;flex:0 0 26px;border-radius:8px;display:grid;place-items:center;font-size:11px;font-weight:700;color:#fff;background:rgba(255,255,255,.08)}
.side a.item.on .tile{background:linear-gradient(135deg,#6E8CFF,#4C70F0)}
.side .label{flex:1;display:grid;line-height:16px}
.side .label small{font-size:11px;color:rgba(255,255,255,.45)}
.side .badge{min-width:22px;padding:0 7px;height:20px;border-radius:999px;background:rgba(255,255,255,.12);color:#fff;font-size:11px;font-weight:700;display:grid;place-items:center}
.side .grow{flex:1}
.side .writes{padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06);display:grid;gap:4px}
.side .writes strong{color:#fff;font-size:12px}
.side .writes span{font-size:11px;line-height:16px;color:rgba(255,255,255,.6)}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.bar{min-height:64px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 28px;flex-wrap:wrap}
.crumb{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.crumb i{color:var(--line-strong);font-style:normal}.crumb b{color:var(--ink);font-weight:600}
.bar .right{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.bar .search{width:300px;max-width:32vw;height:36px;background:var(--soft)}
.me{display:flex;align-items:center;gap:10px;color:var(--ink)}
.avatar{width:34px;height:34px;flex:0 0 34px;border-radius:999px;background:var(--primary-100);color:var(--primary-700);display:grid;place-items:center;font-weight:700;font-size:12px}
.avatar.sm{width:32px;height:32px;flex-basis:32px;font-size:11px}
.me span.n{display:grid;line-height:16px;font-size:13px;font-weight:600}
.me small{font-size:11px;color:var(--muted);font-weight:400;text-transform:capitalize}
.wrap{max-width:1200px;width:100%;margin:0 auto;padding:28px 32px 96px;display:grid;gap:24px;align-content:start}
.wrap>*{min-width:0;margin:0}

.head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.head>div{display:grid;gap:4px}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--primary)}
.eyebrow.soft{color:var(--softink)}
h1{margin:0;font-family:var(--display);font-size:26px;line-height:32px;font-weight:700;letter-spacing:-.01em}
h2{margin:0 0 12px;font-size:16px;line-height:24px;font-weight:700}
.sub{margin:0;color:var(--muted);max-width:720px;text-wrap:pretty}
p{margin:0 0 12px}p:last-child{margin-bottom:0}
.muted{color:var(--muted)}.small{font-size:13px}.tiny{font-size:12px;line-height:18px}
.mono{font-family:var(--mono);font-size:12px}
.stack{display:grid;gap:24px}.stack.tight{gap:12px}

.card{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-sm);padding:24px}
.card.flush{padding:0;overflow:hidden}
.card.flush>.pad{padding:20px 24px}
.card-h{padding:20px 24px 12px;display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.card-h h2{margin:0}
.card-f{padding:14px 24px;border-top:1px solid var(--line);background:var(--soft);display:flex;gap:12px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
.card-f .fill{flex:1;min-width:180px}
.empty{padding:32px 24px;color:var(--muted);text-align:center}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
a.stat,.stat{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;display:grid;gap:2px;color:var(--ink);transition:border-color 160ms ease;align-content:start}
a.stat:hover{border-color:var(--primary);color:var(--ink)}
.stat b{font-family:var(--display);font-size:28px;line-height:36px;font-weight:700}
.stat strong{font-weight:600}
.stat span{font-size:12px;line-height:18px;color:var(--muted)}

.note{position:relative;border-radius:12px;padding:12px 16px 12px 36px;font-size:13px;background:var(--chip);color:var(--chipink)}
.note::before{content:"";position:absolute;left:16px;top:19px;width:8px;height:8px;border-radius:999px;background:var(--line-strong)}
.note a{font-weight:600;color:inherit;text-decoration:underline}
.note.ok{background:var(--okbg);color:var(--ok)}.note.ok::before{background:#38BB94}
.note.err{background:var(--badbg);color:var(--bad)}.note.err::before{background:#F13C47}
.note.warn{background:var(--warnbg);color:var(--warn)}.note.warn::before{background:#FFA030}
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:20;width:max-content;max-width:min(640px,calc(100vw - 32px));padding:12px 18px;border-radius:12px;background:#23283C;color:#fff;
font-size:13px;box-shadow:var(--shadow-md);display:flex;gap:10px;align-items:flex-start;animation:rzFade 180ms ease}
.toast i{width:8px;height:8px;flex:0 0 8px;border-radius:999px;margin-top:7px;background:#38BB94}
.toast.err i{background:#F13C47}
.toast span{flex:1;overflow-wrap:anywhere}
.toast a{color:rgba(255,255,255,.7);font-weight:600;white-space:nowrap}.toast a:hover{color:#fff}

.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:12px;border-bottom:1px solid var(--hair);vertical-align:top}
th{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--softink);background:var(--soft);
border-bottom:1px solid var(--line);white-space:nowrap;padding-top:10px;padding-bottom:10px}
tbody tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right}
.card.flush table th{border-top:1px solid var(--line)}
.card.flush th:first-child,.card.flush td:first-child{padding-left:24px}
.card.flush th:last-child,.card.flush td:last-child{padding-right:24px}

.chip{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;line-height:18px;font-weight:600;background:var(--chip);color:var(--chipink);white-space:nowrap}
.chip.ok{background:var(--okbg);color:var(--ok)}
.chip.warn{background:var(--warnbg);color:var(--warn)}
.chip.bad{background:var(--badbg);color:var(--bad)}
.chip.info{background:var(--infobg);color:var(--info)}
.chip.primary{background:var(--primary-100);color:var(--primary-700)}
a.chip:hover{filter:brightness(.97)}

label{display:grid;gap:4px;font-size:12px;font-weight:600;color:var(--muted)}
label.check{display:flex;gap:8px;align-items:center;font-size:13px;font-weight:400;color:var(--ink)}
input[type=text],input[type=email],input[type=password],input[type=search],select,textarea{width:100%;height:38px;padding:0 12px;border:1px solid var(--line);
border-radius:8px;font-size:13px;color:var(--ink);background:#fff;outline:none}
textarea{height:auto;min-height:120px;padding:10px 12px;line-height:20px}
input:focus,select:focus,textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(76,112,240,.18)}
input[type=file]{font-size:13px;color:var(--muted);max-width:100%}
input[type=checkbox]{width:16px;height:16px;accent-color:var(--primary);margin:0}
button,.btn{height:38px;padding:0 14px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink);font-weight:600;font-size:14px;
cursor:pointer;white-space:nowrap;transition:all 160ms ease;display:inline-flex;align-items:center;justify-content:center}
button:hover,.btn:hover{border-color:var(--primary);color:var(--primary)}
button.primary,.btn.primary,button.good{background:var(--primary);border-color:var(--primary);color:#fff}
button.primary:hover,.btn.primary:hover,button.good:hover{background:var(--primary-600);border-color:var(--primary-600);color:#fff;transform:translateY(-1px)}
button.lift,.btn.lift{box-shadow:var(--shadow-primary)}
button.danger{border-color:#F5C2C6;color:var(--bad)}button.danger:hover{background:var(--badbg);border-color:#F5C2C6;color:var(--bad)}
button.sm,.btn.sm{height:34px;font-size:13px}
button.link{height:auto;padding:0;border:none;background:none;font-size:12px;font-weight:600;color:var(--muted)}
button.link:hover{color:var(--bad)}
button:disabled{opacity:.5;cursor:not-allowed;transform:none}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}.row>div,.row>label{flex:1;min-width:170px}.row>.fit{flex:0 0 auto;min-width:0}
dl.kv{display:grid;grid-template-columns:minmax(120px,200px) 1fr;gap:8px 16px;margin:0;font-size:13px}
dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;overflow-wrap:anywhere}
.pager{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 16px;font-size:12px;color:var(--muted);flex-wrap:wrap}
.pager a{font-weight:600}
form.inline{display:inline}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.tiles>div{padding:12px 14px;border-radius:12px;background:var(--soft);display:grid;gap:2px}
.tiles span{font-size:12px;color:var(--muted)}.tiles strong{font-size:14px;overflow-wrap:anywhere}
.tiles>div.warn{background:var(--warnbg)}.tiles>div.warn strong{color:var(--warn)}
.lines>*{display:grid;gap:16px;align-items:center;padding:12px 24px;border-top:1px solid var(--hair);font-size:13px}
.dot{width:8px;height:8px;flex:0 0 8px;border-radius:999px;display:inline-block;background:var(--line-strong)}
.dot.ok{background:#38BB94}.dot.warn{background:#FFA030}.dot.bad{background:#F13C47}.dot.primary{background:var(--primary)}
.clip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.need{display:flex;gap:14px;align-items:center;padding:14px 24px;border-top:1px solid var(--hair);font-size:13px}
.need .dot{margin-top:0}.need .t{flex:1;display:grid;gap:2px;min-width:0}
.onb{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.onb>div{padding:16px;border-radius:12px;background:var(--soft);display:grid;gap:4px;align-content:start}
.runline{grid-template-columns:48px minmax(0,1fr) 100px 150px 150px}
.tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--line)}
.tabs a{display:flex;gap:8px;align-items:center;padding:10px 14px;font-size:13px;font-weight:600;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a:hover{color:var(--ink)}
.tabs a.on{color:var(--primary);border-bottom-color:var(--primary)}
.tabs a span{padding:0 8px;border-radius:999px;background:var(--chip);color:var(--chipink);font-size:11px;line-height:18px;font-weight:700}
.tabs a.on span{background:var(--primary-100);color:var(--primary-700)}
.split{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:16px;align-items:start}
.split>.panel{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow-y:auto;border-radius:16px}
.bulk{display:none;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 16px;background:var(--primary-100);color:var(--primary-700);font-size:13px}
.lhead,.lrow{display:grid;grid-template-columns:40px minmax(0,1fr);align-items:center}
.lhead{background:var(--soft);border-bottom:1px solid var(--line);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--softink)}
.lhead>span:first-child,.lrow>span:first-child{padding-left:16px;display:flex;align-items:center}
.lcols{display:grid;grid-template-columns:minmax(0,1fr) 130px 124px;gap:12px;align-items:center;padding:10px 16px 10px 0;min-width:0}
.lrow{border-bottom:1px solid var(--hair);font-size:13px}
.lrow a.lcols{color:var(--ink)}
.lrow:hover{background:var(--soft)}
.lrow.on{background:var(--primary-100);box-shadow:inset 3px 0 0 var(--primary)}
.sec{padding:14px 24px;border-top:1px solid var(--hair);display:grid;gap:8px}
.sec.soft{background:var(--soft);gap:10px}
.checkrow{display:grid;grid-template-columns:8px 78px minmax(0,1fr);gap:10px;align-items:baseline;font-size:13px}
.frow{display:grid;grid-template-columns:84px minmax(0,1fr);gap:12px;font-size:13px}
details.raw{border-top:1px solid var(--hair)}
details.raw>summary{list-style:none;cursor:pointer;padding:14px 24px;display:flex;justify-content:space-between;font-size:13px;font-weight:600}
details.raw>summary::-webkit-details-marker{display:none}
.filerow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;align-items:center;padding:10px 12px;border-radius:10px;background:var(--soft);font-size:13px}
.upload{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:24px}
.drop{border:1.5px dashed var(--line-strong);border-radius:12px;background:var(--soft);padding:24px;display:grid;gap:6px;justify-items:center;align-content:center;
text-align:center;cursor:pointer;min-height:180px;font-weight:400;color:var(--ink);font-size:13px;transition:border-color 160ms ease}
.drop{position:relative}
.drop input[type=file]{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
.drop:hover,.drop:focus-within{border-color:var(--primary)}
.drop .ic{width:44px;height:44px;border-radius:12px;background:var(--primary-100);color:var(--primary-700);display:grid;place-items:center;font-size:11px;font-weight:700}
button.pick{height:26px;padding:0 10px;border-radius:999px;font-size:12px;background:var(--chip);border-color:transparent;color:var(--chipink)}
.mapgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 16px;padding:4px 24px 20px}
.steps{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;font-weight:600;color:var(--softink)}
.steps span{display:flex;gap:6px;align-items:center}
.steps span::before{content:"";width:8px;height:8px;border-radius:999px;background:var(--line-strong)}
.steps span.done{color:var(--ok)}.steps span.done::before{background:#38BB94}
.steps span.now{color:var(--primary-700)}.steps span.now::before{background:var(--primary)}
.steps i{width:24px;height:1px;background:var(--line-strong)}
.arow{display:grid;grid-template-columns:150px 140px minmax(0,1fr);gap:16px;padding:12px 24px;border-top:1px solid var(--hair);font-size:13px}
.arow .mono{color:var(--softink);overflow-wrap:anywhere}
.login{max-width:400px;margin:9vh auto;padding:0 16px;display:grid;gap:20px}
.login .brand{padding:0;color:var(--ink);justify-content:center}.login .brand b{color:var(--ink);font-size:18px}.login .brand small{color:var(--muted)}
.login form{display:grid;gap:14px}
@media(max-width:900px){.app{display:block}.side{position:static;width:auto;height:auto}.side .grow{display:none}
.wrap{padding:20px 16px 96px}.bar{padding:10px 16px}.bar .search{max-width:none;width:100%}
dl.kv{grid-template-columns:1fr}dl.kv dt{margin-top:6px}
.split,.upload{grid-template-columns:1fr}.split>.panel{position:static;max-height:none}
.lcols{grid-template-columns:minmax(0,1fr) 110px}.lcols>span:nth-child(2){display:none}
.runline{grid-template-columns:40px minmax(0,1fr) auto}.runline>*:nth-child(3),.runline>*:nth-child(5){display:none}
.arow{grid-template-columns:1fr;gap:2px}.need{flex-wrap:wrap}}
`;

type NavItem = { href: string; label: string; key: string; tag: string; hint?: string; badge?: number; admin?: boolean };

export const Csrf: FC<{ session: Session }> = ({ session }) => <input type="hidden" name="_csrf" value={session.csrfToken} />;

export const Shell: FC<{ title: string; children?: Child }> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{title} · Lead Engine</title>
      <link rel="icon" href="/assets/logo.png" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="stylesheet" href={FONTS} />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>{children}</body>
  </html>
);

export const Brand: FC = () => (
  <a class="brand" href="/">
    <img src="/assets/logo.png" alt="Referrizer" />
    <span>
      <b>Lead Engine</b>
      <small>Scraped leads to approved exports</small>
    </span>
  </a>
);

// The message a redirect carried. It stays until the person closes it: an error is not something
// to fade away on its own.
export const Flash: FC<{ c: Ctx; inline?: boolean }> = ({ c, inline }) => {
  const okText = c.req.query("ok");
  const errText = c.req.query("err");
  const text = errText || okText;
  if (!text) return null;
  if (inline) return <div class={`note ${errText ? "err" : "ok"}`}>{text}</div>;
  const url = new URL(c.req.url);
  url.searchParams.delete("ok");
  url.searchParams.delete("err");
  return (
    <div class={`toast ${errText ? "err" : "ok"}`} role="status">
      <i></i>
      <span>{text}</span>
      <a href={`${url.pathname}${url.search}`}>Close</a>
    </div>
  );
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const text = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? "?").slice(0, 2);
  return text.toUpperCase();
}

export const Avatar: FC<{ name: string; small?: boolean }> = ({ name, small }) => (
  <span class={`avatar${small ? " sm" : ""}`}>{initials(name)}</span>
);

export const Page: FC<{
  c: Ctx;
  title: string;
  active: string;
  sub?: string;
  step?: string;
  crumb?: string;
  aside?: Child;
  children?: Child;
}> = ({ c, title, active, sub, step, crumb, aside, children }) => {
  const session = c.get("session");
  const nav = c.get("nav");
  const top: NavItem[] = [
    { href: "/", label: "Overview", key: "home", tag: "Ov" },
    { href: "/approvals", label: "Approvals", key: "approvals", tag: "Ap", badge: nav.pending },
  ];
  const steps: NavItem[] = [
    { href: "/scrape", label: "Scrape", key: "scrape", tag: "1", hint: "Octoparse tasks" },
    { href: "/imports", label: "Import", key: "imports", tag: "2", hint: "Upload and match columns", badge: nav.unmapped },
    { href: "/checks", label: "Checks", key: "checks", tag: "3", hint: "DNC, VICIdial, Close" },
    { href: "/leads", label: "Review", key: "review", tag: "4", hint: "Approve or reject", badge: nav.inReview },
    { href: "/exports", label: "Export", key: "exports", tag: "5", hint: "Batches and downloads" },
  ];
  const more: NavItem[] = [
    { href: "/audit-log", label: "Audit log", key: "audit", tag: "Lg" },
    { href: "/settings", label: "Settings", key: "settings", tag: "St", admin: true },
  ];
  const item = (entry: NavItem) => (
    <a href={entry.href} class={`item${entry.key === active ? " on" : ""}`}>
      <span class="tile">{entry.tag}</span>
      <span class="label">
        {entry.label}
        {entry.hint ? <small>{entry.hint}</small> : null}
      </span>
      {entry.badge ? <span class="badge">{count(entry.badge)}</span> : null}
    </a>
  );
  return (
    <Shell title={title}>
      <div class="app">
        <aside class="side">
          <Brand />
          {top.map(item)}
          <div class="group">Pipeline</div>
          {steps.map(item)}
          <div class="group">More</div>
          {more.filter((entry) => !entry.admin || can(session, "admin")).map(item)}
          <div class="grow"></div>
          <div class="writes">
            <strong>External writes are {nav.externalWrites ? "on" : "off"}</strong>
            <span>
              This build connects to nothing outside. Close and VICIdial are known only from uploaded files, and exports are CSV
              files.
            </span>
          </div>
        </aside>
        <div class="main">
          <header class="bar">
            <div class="crumb">
              <span>Lead Engine</span>
              <i>/</i>
              <b>{crumb ?? title}</b>
            </div>
            <div class="right">
              <form method="get" action="/leads" role="search">
                <input type="hidden" name="tab" value="all" />
                <input class="search" type="search" name="q" placeholder="Search leads by name, phone or website" aria-label="Search leads" />
              </form>
              <a class="me" href="/account" title="Your account">
                <Avatar name={session.user.name} />
                <span class="n">
                  {session.user.name}
                  <small>{session.user.role}</small>
                </span>
              </a>
              <form method="post" action="/logout" class="inline">
                <Csrf session={session} />
                <button class="sm" type="submit">
                  Sign out
                </button>
              </form>
            </div>
          </header>
          <main class="wrap">
            <div class="head">
              <div>
                {step ? <span class="eyebrow">{step}</span> : null}
                <h1>{title}</h1>
                {sub ? <p class="sub">{sub}</p> : null}
              </div>
              {aside ?? null}
            </div>
            {children}
          </main>
        </div>
      </div>
      <Flash c={c} />
    </Shell>
  );
};

const STATUS: Record<string, [label: string, tone: string]> = {
  in_review: ["In review", "warn"],
  needs_info: ["Needs info", "info"],
  approved: ["Approved", "ok"],
  rejected: ["Rejected", "bad"],
  exported: ["Exported", "ok"],
  duplicate: ["Duplicate", ""],
  in_vici: ["In VICIdial", ""],
  in_close: ["In Close", ""],
  blocked_dnc: ["Blocked DNC", "bad"],
  invalid: ["Invalid", "bad"],
  needs_mapping: ["Match columns", "warn"],
  processing: ["Importing", "warn"],
  done: ["Imported", "ok"],
  failed: ["Failed", "bad"],
  draft: ["Draft", "warn"],
  awaiting_approval: ["Awaiting approval", "warn"],
  running: ["Running", "warn"],
  pending: ["Waiting", "warn"],
  used: ["Approved", "ok"],
  void: ["No longer applies", ""],
  loaded: ["Loaded", "ok"],
};

export const statusLabel = (value: string) => STATUS[value]?.[0] ?? value.replace(/_/g, " ");

export const Chip: FC<{ value: string; label?: string; tone?: string; href?: string }> = ({ value, label, tone, href }) => {
  const cls = `chip ${tone ?? STATUS[value]?.[1] ?? ""}`;
  const text = label ?? statusLabel(value);
  return href ? (
    <a class={cls} href={href}>
      {text}
    </a>
  ) : (
    <span class={cls}>{text}</span>
  );
};

export function when(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

export function day(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export const count = (value: number) => value.toLocaleString("en-US");

// A US or Canadian number reads as (512) 555-0142; any other stays in its international form.
export function phone(value: string | null | undefined): string {
  if (!value) return "";
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : value;
}

export const Pager: FC<{ page: number; pages: number; total: number; shown: number; href: (page: number) => string; noun: string; size: number }> = ({
  page,
  pages,
  total,
  shown,
  href,
  noun,
  size,
}) => (
  <div class="pager">
    <span>
      {total === 0 ? `No ${noun}` : `Showing ${count(shown)} of ${count(total)} ${noun}`}
      {pages > 1 ? ` · page ${page} of ${pages}` : ""}
    </span>
    <span style="display:flex;gap:12px">
      {page > 1 ? <a href={href(page - 1)}>← Previous</a> : null}
      {page < pages ? <a href={href(page + 1)}>Next →</a> : null}
      <span>{size} per page</span>
    </span>
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
  system: "Exported from",
  leadsReleased: "Leads that stop being marked as already there",
  canBeUndone: "Can be undone",
};

function estimateValue(key: string, value: unknown): string {
  if (key === "dncNeverLoaded") return value ? "Not done. No DNC list is loaded." : "Checked against the loaded lists";
  if (key === "target" && value === "csv") return "CSV file download";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "number" ? count(value) : String(value);
}

// What an approval request covers, as the approver should see it.
export const Estimate: FC<{ data: Record<string, unknown> }> = ({ data }) => (
  <div class="tiles">
    {Object.entries(data)
      .filter(([key]) => ESTIMATE_LABELS[key])
      .map(([key, value]) => (
        <div class={key === "dncNeverLoaded" && value === true ? "warn" : ""}>
          <span>{ESTIMATE_LABELS[key]}</span>
          <strong>{estimateValue(key, value)}</strong>
        </div>
      ))}
  </div>
);

export function render(c: Ctx, page: unknown): Response | Promise<Response> {
  return c.html(html`<!doctype html>${page}`);
}

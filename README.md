# Lead Engine

A web app that takes scraped business leads from a CSV file to an approved export, without any bot in the loop:

**upload CSV → match columns → normalize → dedupe → already in VICIdial / Close? → DNC check → human review → export batch → admin approval → CSV download**

This is Phase 0–1 of the Lead Engine briefing dated 24 Nov 2026. It connects to no outside system: no Close, no VICIdial, no Octoparse API, no Apify, no email finders. What is already in VICIdial and Close is known only from export files uploaded to the app. Exports are CSV files that a person loads into Close or VICIdial by hand.

## What it does

| Step | What happens |
|---|---|
| Import | Upload a CSV (for example an Octoparse Desktop export). Every row is stored untouched in `raw_records`. You match the file's columns to lead fields; the matching is remembered per source name. |
| Normalize | Phone to E.164, website to its host, trimmed names and addresses. |
| Validate | A row missing a required field is kept, marked `invalid`, and shows why. |
| Dedupe | Against earlier rows of the same file and every lead already in the database. A duplicate links to the lead it repeats. A reviewer can overrule it with a reason. |
| Existing records | Upload a file exported from VICIdial or Close. A lead whose phone number is in one is marked `in_vici` or `in_close` and held back, at import and again whenever a new file is uploaded. It is a snapshot as of the export, matched on phone only. When no file is loaded the screens say the leads were not compared. |
| DNC | Numbers on an uploaded do-not-call list are `blocked_dnc`. Uploading a list re-checks every lead that can still be exported. Export checks again, live. |
| Review | Approve, reject (reason required) or mark "needs info", one lead or many. Every decision is stored. |
| Export | Approved leads go into a batch. The batch needs an admin's approval before its CSV can be downloaded. The first download marks the leads `exported`. |
| Delete | Deleting an import, a DNC list or a VICIdial / Close file is a request that an admin must approve. |

## The approval rule

Nothing is exported or deleted without a person clicking approve.

- A gated action runs only if an `approvals` row exists that is approved, names the approving user, and carries a hash of exactly what was approved (`src/gate.ts`, `assertApproved`). The database refuses an approved row with no approver.
- The approval is tied to a snapshot. If a batch changes after it was approved, the approval no longer applies.
- Approving is only reachable from a signed-in admin's own form post. There is no API key, webhook or background job that can approve.
- `APPROVALS_REQUIRE_SECOND_PERSON=true` makes the approver a different person from the requester.
- `EXTERNAL_WRITES_ENABLED` is off by default. Nothing uses it yet; any future adapter that writes to or spends on an outside system must call `assertExternalWritesEnabled` first.

## Rules that are still open

These came from the old bot team and nobody has written them down. They are settings (Settings page, admins only), with starting values that are guesses, not confirmed business rules:

| Rule | Starting value | Briefing question |
|---|---|---|
| Required fields for a valid lead | business name, valid phone | 1 |
| Duplicate keys | same phone, or same website | 3 |
| Shared websites ignored for dedupe | facebook.com, yelp.com and similar | 3 |
| Country for numbers with no country code | US | n/a |
| Who can approve | admins only (in code, `src/approvals.ts`) | 12 |
| Second approver required | off (env var) | 12 |

**DNC:** the app only compares numbers with the files uploaded to it. Which lists are legally required has not been decided here. When no list is loaded, every screen involved says the leads have not been scrubbed.

## Running it locally

```
npm install
copy .env.example .env      # set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters)
npm run dev
```

With no `DATABASE_URL`, the app uses a file database in `./.data` (PGlite, Postgres compiled to run in-process). That is for local work only; production refuses to start without `DATABASE_URL`.

```
npm test         # 39 tests, in-memory database, no network
npm run build    # type check
```

## Deploying to Railway

One service plus the Postgres plugin. No Redis, no worker, no cron yet: imports run inside the request, which is fine for files up to the row limit.

1. Create a Railway project from this repo and add Postgres.
2. Set the service variables: `DATABASE_URL` (reference the Postgres one), `NODE_ENV=production`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and optionally `APPROVALS_REQUIRE_SECOND_PERSON=true`.
3. Deploy. `railway.json` runs `npm run start`, which applies migrations, creates the first admin if there are no users, and serves on `PORT`. Health check: `/health`.
4. Sign in, then add the team under Users. The app sends no email; pass starting passwords on yourself.

`ADMIN_PASSWORD` is only read while the users table is empty. Remove it from the variables after the first sign-in.

## Roles

| Role | Can |
|---|---|
| viewer | See everything |
| reviewer | Upload, match columns, review leads, upload DNC lists, build batches, request approval, download an approved batch |
| admin | All of that, plus approve or reject requests, change settings, manage users |

## Layout

```
src/config.ts            environment variables
src/db/                  database access, migrations (SQL files)
src/pipeline/            csv, column mapping, normalize, import + dedupe, DNC, VICIdial / Close files
src/reviews.ts           approve / reject / needs info / not a duplicate
src/exports.ts           batches, live eligibility check, CSV output
src/deletes.ts           deleting an import, a DNC list or a VICIdial / Close file
src/gate.ts              the approval check every gated action makes
src/approvals.ts         requesting and deciding approvals
src/auth.ts              accounts, passwords, sessions
src/server/              pages (Hono, server-rendered)
tests/                   pipeline, gates, and a full run through the pages
```

## Not built yet

Phases 2–6 of the briefing: a live read-only Close and VICIdial cross-reference (today it works from uploaded export files), enrichment with spend gates, scoring, direct export to Close / VICIdial, automated scraping. Each of those needs answers from the briefing's open questions first, and anything that writes to Close or VICIdial or spends money needs sign-off before it is built.

Also not handled: Excel (.xlsx) uploads (save as CSV first), email notifications, password reset by email.

-- Lead Engine, phase 0-1 schema.
-- Enrichment and scoring tables are left for the phases that need them: their shape depends on
-- answers the briefing still lists as open.

CREATE TABLE users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'reviewer', 'viewer')),
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by INTEGER REFERENCES users (id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sources (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('octoparse', 'apify', 'crawlee', 'osm', 'google_places', 'csv')),
  name TEXT NOT NULL UNIQUE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources (id),
  status TEXT NOT NULL CHECK (status IN ('needs_mapping', 'queued', 'running', 'done', 'failed')),
  file_name TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary_json JSONB,
  external_run_id TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  cost_estimate NUMERIC,
  cost_actual NUMERIC,
  error TEXT,
  created_by INTEGER REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Scraped rows exactly as they arrived. Never edited.
CREATE TABLE raw_records (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  payload_json JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX raw_records_run_idx ON raw_records (run_id, row_number);

CREATE TABLE leads (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  source_record_id INTEGER REFERENCES raw_records (id) ON DELETE SET NULL,
  business_name TEXT,
  phone_raw TEXT,
  phone_e164 TEXT,
  website TEXT,
  website_domain TEXT,
  email TEXT,
  owner_name TEXT,
  address TEXT,
  city TEXT,
  region TEXT,
  postal_code TEXT,
  country TEXT,
  category TEXT,
  name_key TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'invalid', 'duplicate', 'blocked_dnc', 'in_close', 'in_vici', 'enriching',
    'in_review', 'approved', 'rejected', 'exported'
  )),
  status_reason TEXT,
  -- NULL means this lead has never been compared with a DNC list. It is not the same as "clear".
  dnc_checked_at TIMESTAMPTZ,
  normalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX leads_phone_idx ON leads (phone_e164);
CREATE INDEX leads_domain_idx ON leads (website_domain);
CREATE INDEX leads_name_key_idx ON leads (name_key);
CREATE INDEX leads_status_idx ON leads (status);
CREATE INDEX leads_run_idx ON leads (run_id);

CREATE TABLE dedupe_matches (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  match_type TEXT NOT NULL CHECK (match_type IN ('internal', 'close', 'vici', 'dnc')),
  matched_ref TEXT NOT NULL,
  matched_lead_id INTEGER REFERENCES leads (id) ON DELETE CASCADE,
  rule_used TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dedupe_matches_lead_idx ON dedupe_matches (lead_id);
CREATE INDEX dedupe_matches_matched_idx ON dedupe_matches (matched_lead_id);

CREATE TABLE dnc_lists (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  file_name TEXT,
  number_count INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users (id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dnc_numbers (
  phone_e164 TEXT NOT NULL,
  list_id INTEGER NOT NULL REFERENCES dnc_lists (id) ON DELETE CASCADE,
  PRIMARY KEY (phone_e164, list_id)
);

CREATE TABLE audit_decisions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  reviewer_user_id INTEGER NOT NULL REFERENCES users (id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'needs_info', 'not_duplicate')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_decisions_lead_idx ON audit_decisions (lead_id);

CREATE TABLE export_batches (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('csv', 'close', 'vicidial')),
  target_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'running', 'done', 'failed')),
  created_by INTEGER NOT NULL REFERENCES users (id),
  requested_by INTEGER REFERENCES users (id),
  approved_by INTEGER REFERENCES users (id),
  approved_at TIMESTAMPTZ,
  result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE export_batch_leads (
  batch_id INTEGER NOT NULL REFERENCES export_batches (id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads (id),
  PRIMARY KEY (batch_id, lead_id)
);
CREATE INDEX export_batch_leads_lead_idx ON export_batch_leads (lead_id);

-- One row per request to import, spend or delete. A gated action runs only when its row is
-- 'approved', approved_by is a user, and snapshot_hash still matches the thing being acted on.
CREATE TABLE approvals (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action_type TEXT NOT NULL CHECK (action_type IN ('import', 'spend', 'delete')),
  subject_type TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'void', 'used')),
  snapshot_hash TEXT NOT NULL,
  estimate_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT,
  requested_by INTEGER NOT NULL REFERENCES users (id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set only when a person approved. A rejection fills decided_by and leaves this empty.
  approved_by INTEGER REFERENCES users (id),
  approved_at TIMESTAMPTZ,
  decided_by INTEGER REFERENCES users (id),
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  CHECK (status NOT IN ('approved', 'used') OR approved_by IS NOT NULL)
);
CREATE INDEX approvals_subject_idx ON approvals (subject_type, subject_id);
CREATE INDEX approvals_status_idx ON approvals (status);

CREATE TABLE audit_log (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

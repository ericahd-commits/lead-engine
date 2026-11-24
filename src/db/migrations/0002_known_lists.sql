-- Phone numbers that already exist in VICIdial or Close, loaded from files exported out of those
-- systems. A snapshot as of the upload, not a live connection: the app never contacts either one.

CREATE TABLE known_lists (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('vici', 'close')),
  name TEXT NOT NULL,
  file_name TEXT,
  number_count INTEGER NOT NULL DEFAULT 0,
  -- The columns the numbers were read from. NULL means every column was scanned, because the
  -- file had no header naming a phone column.
  phone_columns TEXT,
  uploaded_by INTEGER REFERENCES users (id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE known_numbers (
  phone_e164 TEXT NOT NULL,
  list_id INTEGER NOT NULL REFERENCES known_lists (id) ON DELETE CASCADE,
  PRIMARY KEY (phone_e164, list_id)
);

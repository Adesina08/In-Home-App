const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "..", "data.sqlite");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS studies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  market TEXT,
  category TEXT,
  status TEXT DEFAULT 'draft',           -- draft | live | closed
  diary_mode TEXT DEFAULT 'daily',       -- realtime | daily | weekly | monthly
  recruitment_mode TEXT DEFAULT 'hybrid',-- f2f | remote | hybrid
  back_entry_hours INTEGER DEFAULT 24,
  recall_window_hours INTEGER DEFAULT 48,
  mandatory_photo INTEGER DEFAULT 1,
  duplicate_similarity_threshold REAL DEFAULT 0.9,
  burst_entry_count_threshold INTEGER DEFAULT 3,
  burst_entry_window_hours INTEGER DEFAULT 2,
  reminder_due_hours INTEGER,
  reminder_missed_hours INTEGER,
  default_reminder_channel TEXT DEFAULT 'whatsapp',
  version INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,                    -- admin | research | interviewer | client
  study_id INTEGER,                      -- scoping for client/interviewer role (nullable = all studies, admin/research)
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(study_id) REFERENCES studies(id)
);

CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  sku TEXT,
  active INTEGER DEFAULT 1,
  FOREIGN KEY(study_id) REFERENCES studies(id)
);

CREATE TABLE IF NOT EXISTS consent_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'draft',           -- draft | approved
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(study_id) REFERENCES studies(id)
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL,
  order_index INTEGER DEFAULT 0,
  code TEXT,
  type TEXT NOT NULL,                    -- single | multi | numeric | text | date | photo
  text TEXT NOT NULL,
  required INTEGER DEFAULT 1,
  options_json TEXT,                     -- JSON array for single/multi
  min_value REAL,
  max_value REAL,
  active INTEGER DEFAULT 1,
  FOREIGN KEY(study_id) REFERENCES studies(id)
);

CREATE TABLE IF NOT EXISTS skip_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL,
  target_question_id INTEGER NOT NULL,   -- the question this rule controls
  condition_question_id INTEGER NOT NULL,
  operator TEXT DEFAULT 'equals',        -- equals | not_equals
  value TEXT,
  action TEXT DEFAULT 'show',            -- show | hide
  FOREIGN KEY(study_id) REFERENCES studies(id),
  FOREIGN KEY(target_question_id) REFERENCES questions(id),
  FOREIGN KEY(condition_question_id) REFERENCES questions(id)
);

CREATE TABLE IF NOT EXISTS kpi_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL,
  kpi_key TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  FOREIGN KEY(study_id) REFERENCES studies(id)
);

CREATE TABLE IF NOT EXISTS respondents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL,
  respondent_code TEXT UNIQUE,
  name TEXT,
  contact TEXT,                          -- phone / whatsapp / email
  recruitment_mode TEXT,                 -- f2f | remote
  preferred_channel TEXT DEFAULT 'app',  -- app | whatsapp
  consent_status TEXT DEFAULT 'pending', -- pending | given | declined
  activation_status TEXT DEFAULT 'invited', -- invited | screened | registered | activated | active | completed
  unique_token TEXT UNIQUE,
  interviewer_id INTEGER,
  is_practice INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(study_id) REFERENCES studies(id),
  FOREIGN KEY(interviewer_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS diary_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  respondent_id INTEGER NOT NULL,
  study_id INTEGER NOT NULL,
  period_label TEXT,                     -- e.g. 2026-08-19 or 2026-W34
  occurrence_time TEXT,
  entry_time TEXT DEFAULT (datetime('now')),
  submit_time TEXT,
  channel TEXT DEFAULT 'app',            -- app | whatsapp
  status TEXT DEFAULT 'draft',           -- draft | submitted
  is_practice INTEGER DEFAULT 0,
  entry_mode TEXT DEFAULT 'standard',    -- standard | video | audio (how the respondent chose to log this entry)
  FOREIGN KEY(respondent_id) REFERENCES respondents(id),
  FOREIGN KEY(study_id) REFERENCES studies(id)
);

CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  value TEXT,
  study_version INTEGER,
  FOREIGN KEY(record_id) REFERENCES diary_records(id),
  FOREIGN KEY(question_id) REFERENCES questions(id)
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  media_type TEXT DEFAULT 'photo',       -- photo | video | audio
  file_path TEXT,
  upload_time TEXT DEFAULT (datetime('now')),
  qc_status TEXT DEFAULT 'pending',
  detection_status TEXT DEFAULT 'not_run', -- not_run | unavailable | done | error
  detected_brand TEXT,
  detection_provider TEXT,
  detection_raw_json TEXT,
  transcript_status TEXT DEFAULT 'not_run', -- not_run | unavailable | done | error (audio notes)
  transcript_text TEXT,
  transcript_provider TEXT,
  transcript_raw_json TEXT,
  FOREIGN KEY(record_id) REFERENCES diary_records(id)
);

CREATE TABLE IF NOT EXISTS question_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL,
  source_filename TEXT,
  source_type TEXT,                       -- spreadsheet | document
  payload_json TEXT NOT NULL,             -- parsed rows, editable before commit
  warnings_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(study_id) REFERENCES studies(id)
);

CREATE TABLE IF NOT EXISTS qc_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  respondent_id INTEGER NOT NULL,
  record_id INTEGER,
  flag_type TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',        -- low | medium | high | critical
  reason TEXT,
  created_time TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'open',            -- open | reviewed | resolved
  reviewer TEXT,
  action_note TEXT,
  resolved_at TEXT,
  FOREIGN KEY(respondent_id) REFERENCES respondents(id),
  FOREIGN KEY(record_id) REFERENCES diary_records(id)
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  respondent_id INTEGER NOT NULL,
  requirement TEXT,
  channel TEXT DEFAULT 'whatsapp',
  scheduled_time TEXT DEFAULT (datetime('now')),
  sent_time TEXT,
  status TEXT DEFAULT 'scheduled',       -- scheduled | sent | suppressed
  FOREIGN KEY(respondent_id) REFERENCES respondents(id)
);

CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  respondent_id INTEGER,
  template TEXT,
  payload_json TEXT,
  provider TEXT DEFAULT 'mock',
  status TEXT DEFAULT 'simulated',       -- simulated | sent | failed
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  action TEXT,
  entity TEXT,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Lightweight migration for databases created before the media detection columns
// existed (SQLite has no "ADD COLUMN IF NOT EXISTS" — ignore "duplicate column").
const mediaMigrations = [
  "ALTER TABLE media ADD COLUMN detection_status TEXT DEFAULT 'not_run'",
  "ALTER TABLE media ADD COLUMN detected_brand TEXT",
  "ALTER TABLE media ADD COLUMN detection_provider TEXT",
  "ALTER TABLE media ADD COLUMN detection_raw_json TEXT",
  "ALTER TABLE media ADD COLUMN transcript_status TEXT DEFAULT 'not_run'",
  "ALTER TABLE media ADD COLUMN transcript_text TEXT",
  "ALTER TABLE media ADD COLUMN transcript_provider TEXT",
  "ALTER TABLE media ADD COLUMN transcript_raw_json TEXT",
  "ALTER TABLE diary_records ADD COLUMN entry_mode TEXT DEFAULT 'standard'",
];
mediaMigrations.forEach((sql) => {
  try {
    db.prepare(sql).run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
});

module.exports = db;

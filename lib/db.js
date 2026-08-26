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
  role TEXT NOT NULL,                    -- admin | interviewer | client
  study_id INTEGER,                      -- scoping for client/interviewer role (nullable = all studies, admin)
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

-- One row per device a respondent has registered a biometric (fingerprint / Face ID /
-- device PIN) unlock for, via the WebAuthn "platform authenticator" API. A respondent
-- can have more than one (e.g. they later log in from a second phone) -- any one of
-- their registered devices can unlock their diary. See lib/webauthn.js.
CREATE TABLE IF NOT EXISTS respondent_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  respondent_id INTEGER NOT NULL,
  credential_id TEXT UNIQUE NOT NULL,    -- base64url WebAuthn credential ID
  public_key TEXT NOT NULL,              -- base64url-encoded COSE public key
  counter INTEGER DEFAULT 0,
  device_label TEXT,                     -- best-effort, for the respondent's own reference
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(respondent_id) REFERENCES respondents(id)
);

-- One row per device a respondent has granted browser notification permission
-- on and subscribed to push (Web Push / VAPID -- see lib/push.js). A respondent
-- can have several (phone + a browser tab); the reminder engine sends to all
-- of them. endpoint is UNIQUE so the same device re-subscribing updates its
-- existing row instead of accumulating duplicates.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  respondent_id INTEGER NOT NULL,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(respondent_id) REFERENCES respondents(id)
);

-- One-time codes for remote self-onboarding contact verification (spec Flow B
-- step 3, "Verify: Phone/email/OTP"). The code itself is never stored -- only a
-- bcrypt hash -- so a leaked database dump can't be used to walk through
-- anyone's verification. Rows are kept after use (consumed_at set) rather than
-- deleted, so an auditor can see that a given respondent's contact really was
-- verified, and when.
-- Researcher-facing AI summaries (spec 4.3 P1). Every row stores the exact
-- metric bundle and open-text sample the narrative was written from, plus the
-- period and base sizes -- the spec requires the output be "traceable to the
-- selected period/base", and a narrative you can't trace back to its numbers
-- is worse than no narrative at all. provider/model record WHAT produced it,
-- so a template-generated draft is never passed off as model output.
CREATE TABLE IF NOT EXISTS ai_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL,
  period_start TEXT,
  period_end TEXT,
  base_records INTEGER DEFAULT 0,
  base_respondents INTEGER DEFAULT 0,
  metrics_json TEXT,
  open_text_json TEXT,
  narrative TEXT,
  provider TEXT,
  model TEXT,
  used_ai_model INTEGER DEFAULT 0,
  generated_by TEXT,
  generated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(study_id) REFERENCES studies(id)
);

-- A person, as distinct from their participation in any one study.
--
-- The respondents table conflated the two: a row carried both who someone is (name,
-- contact) and their enrolment in exactly one study (token, consent,
-- activation, risk). The same human recruited onto two studies became two
-- unrelated rows sharing a phone number -- which the duplicate-contact check
-- then flagged as suspicious, because at that point it genuinely couldn't
-- tell them apart from one person registering twice.
--
-- Splitting them lets one account hold many enrolments. Consent, activation
-- and QC stay per-enrolment (consent legally must be per-study, against that
-- study's approved wording); identity and login live here.
--
-- contact is the login identifier, stored normalized (see lib/otp.js) so
-- "+234 811..." and "0811..." resolve to the same account.
CREATE TABLE IF NOT EXISTS respondent_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  contact TEXT UNIQUE NOT NULL,
  contact_verified_at TEXT,
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  respondent_id INTEGER,
  contact TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT DEFAULT 'contact_verification',
  attempts INTEGER DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(respondent_id) REFERENCES respondents(id)
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
  "ALTER TABLE questions ADD COLUMN section TEXT",
  // Set when a respondent's device has no platform authenticator at all (older phone,
  // desktop with no fingerprint reader) -- required biometric lock can't be enforced on
  // hardware that doesn't support it, so this documents the exception instead of
  // permanently locking that respondent out of their own diary.
  "ALTER TABLE respondents ADD COLUMN biometric_exempt INTEGER DEFAULT 0",
  // Study version publishing (spec 3.1: "Publish a study version; retain the
  // version used on every submitted diary record"). `studies.version` already
  // existed and is stamped onto every response, but nothing ever incremented
  // it, so edits silently changed what "v1" meant. These track when the
  // current version was published and whether the questionnaire has been
  // edited since -- i.e. whether there are unpublished changes.
  "ALTER TABLE studies ADD COLUMN version_published_at TEXT",
  "ALTER TABLE studies ADD COLUMN questionnaire_dirty INTEGER DEFAULT 0",
  // Remote / digital self-onboarding (spec Core Flow B). join_code is the
  // public study code behind the shareable invite link; the two respondent
  // columns record that they completed the Verify and Train steps, which the
  // F2F flow covers in person and so leaves null.
  "ALTER TABLE studies ADD COLUMN join_code TEXT",
  // (see the research-role migration below the ALTER list)
  "ALTER TABLE respondents ADD COLUMN contact_verified_at TEXT",
  "ALTER TABLE respondents ADD COLUMN tutorial_completed_at TEXT",
  // Each automatic quality check can now be switched off per study, not just
  // tuned. Previously the only way to silence a rule was to set its threshold
  // to an impossible value -- a study with legitimately repetitive consumption
  // (same drink, same place, every evening) would otherwise raise a duplicate
  // flag on every single entry, with no honest way to stop it. Default on, so
  // existing studies keep behaving exactly as before.
  "ALTER TABLE studies ADD COLUMN qc_duplicate_enabled INTEGER DEFAULT 1",
  "ALTER TABLE studies ADD COLUMN qc_burst_enabled INTEGER DEFAULT 1",
  "ALTER TABLE studies ADD COLUMN qc_back_entry_enabled INTEGER DEFAULT 1",
  // Which person this enrolment belongs to. Nullable on purpose: a
  // face-to-face recruit gets a working diary link on the spot without anyone
  // creating a login, and existing respondents keep working untouched.
  "ALTER TABLE respondents ADD COLUMN account_id INTEGER",
  // KPIs used to be a key and a label with nothing behind them: the client
  // dashboard had a hardcoded lookup of six computed values, so anything an
  // admin added rendered as a dash forever. These columns are what let a KPI
  // be defined against the study's own questionnaire and actually computed --
  // see lib/kpi.js. A row with metric NULL is one of the original six, still
  // computed from study-level counts.
  "ALTER TABLE kpi_config ADD COLUMN metric TEXT",
  "ALTER TABLE kpi_config ADD COLUMN question_id INTEGER",
  // Pipe-delimited, matching the house convention for multi-values elsewhere.
  "ALTER TABLE kpi_config ADD COLUMN option_value TEXT",
  // JSON array of { question_id, operator, value } -- the cross-question
  // filter, e.g. "% choosing Brand A, among entries logged at home".
  "ALTER TABLE kpi_config ADD COLUMN conditions_json TEXT",
  "ALTER TABLE kpi_config ADD COLUMN unit TEXT",
];
mediaMigrations.forEach((sql) => {
  try {
    db.prepare(sql).run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
});

// The "research" role has been removed -- it was never distinguishable from
// admin (identical permissions, identical menu, same guard), and the spec
// itself described the tier as one item, "Admin/Research". Any account still
// carrying the old role is promoted to admin rather than left behind: the
// role no longer appears in any guard, so those users would otherwise be
// silently locked out of every screen at their next login.
const researchAccounts = db.prepare("SELECT id, email FROM users WHERE role = 'research'").all();
if (researchAccounts.length) {
  db.prepare("UPDATE users SET role = 'admin' WHERE role = 'research'").run();
  console.log(
    `Migrated ${researchAccounts.length} "research" account(s) to "admin": ${researchAccounts.map((u) => u.email).join(", ")}`
  );
}

// Section-level skip logic: a rule now targets either one question OR an
// entire section (all questions sharing that section together), so
// target_question_id must become nullable and a new target_section column
// is needed. SQLite has no ALTER TABLE ... ALTER COLUMN to relax a NOT NULL
// constraint, so this rebuilds the table -- guarded to run only once by
// checking whether target_section already exists.
const skipRulesInfo = db.prepare("PRAGMA table_info(skip_rules)").all();
const hasTargetSection = skipRulesInfo.some((c) => c.name === "target_section");
if (skipRulesInfo.length && !hasTargetSection) {
  const rebuildSkipRules = db.transaction(() => {
    db.exec(`
      CREATE TABLE skip_rules_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        study_id INTEGER NOT NULL,
        target_question_id INTEGER,
        target_section TEXT,
        condition_question_id INTEGER NOT NULL,
        operator TEXT DEFAULT 'equals',
        value TEXT,
        action TEXT DEFAULT 'show',
        FOREIGN KEY(study_id) REFERENCES studies(id),
        FOREIGN KEY(target_question_id) REFERENCES questions(id),
        FOREIGN KEY(condition_question_id) REFERENCES questions(id)
      );
      INSERT INTO skip_rules_new (id, study_id, target_question_id, condition_question_id, operator, value, action)
        SELECT id, study_id, target_question_id, condition_question_id, operator, value, action FROM skip_rules;
      DROP TABLE skip_rules;
      ALTER TABLE skip_rules_new RENAME TO skip_rules;
    `);
  });
  rebuildSkipRules();
}

// Skip logic gains a third action alongside show/hide: "terminate", which ends
// the diary entry (or the respondent's whole participation) instead of just
// toggling a question's visibility. It needs one more piece of information a
// show/hide rule doesn't -- how far the termination reaches -- stored here as
// terminate_scope ('entry' | 'study'). A plain nullable ADD COLUMN is enough
// (unlike target_section above, nothing here needs to relax a NOT NULL).
const hasTerminateScope = db.prepare("PRAGMA table_info(skip_rules)").all().some((c) => c.name === "terminate_scope");
if (!hasTerminateScope) {
  db.exec(`ALTER TABLE skip_rules ADD COLUMN terminate_scope TEXT;`);
}

// A terminated diary entry keeps a short human-readable note of which rule
// ended it, so admins reviewing "screened_out" entries (see B12 / the diary
// CSV export) can see why without cross-referencing the Skip Logic list.
const hasTerminateNote = db.prepare("PRAGMA table_info(diary_records)").all().some((c) => c.name === "terminate_note");
if (!hasTerminateNote) {
  db.exec(`ALTER TABLE diary_records ADD COLUMN terminate_note TEXT;`);
}

// A study-scoped terminate rule disqualifies the respondent outright (no
// further diary entries at all, see routes/respondent.js) rather than just
// this one entry -- these two columns record when and why for the admin
// Respondents list.
const respondentCols = db.prepare("PRAGMA table_info(respondents)").all().map((c) => c.name);
if (!respondentCols.includes("disqualified_at")) {
  db.exec(`ALTER TABLE respondents ADD COLUMN disqualified_at TEXT;`);
}
if (!respondentCols.includes("disqualify_reason")) {
  db.exec(`ALTER TABLE respondents ADD COLUMN disqualify_reason TEXT;`);
}

module.exports = db;

// What a document looks like when a field wasn't supplied.
//
// SQLite applied these as column DEFAULTs, so a great deal of the app inserts
// partial rows and relies on the database to fill in the rest -- a respondent
// created without `consent_status` came back as "pending", an entry without
// `status` as "draft". MongoDB has no such concept: the field would simply be
// absent, every `status = 'draft'` filter would quietly stop matching it, and
// nothing would throw. That is the single most dangerous difference between the
// two stores, so the defaults are declared here and applied on every insert.
//
// `NOW` means "the moment of insertion", formatted the way the rest of the app
// stores time (see ../store/index.js).

const NOW = Symbol("now");

const DEFAULTS = {
  studies: {
    status: "draft",
    diary_mode: "daily",
    recruitment_mode: "hybrid",
    back_entry_hours: 24,
    recall_window_hours: 48,
    mandatory_photo: 1,
    duplicate_similarity_threshold: 0.9,
    burst_entry_count_threshold: 3,
    burst_entry_window_hours: 2,
    default_reminder_channel: "whatsapp",
    version: 1,
    questionnaire_dirty: 0,
    qc_duplicate_enabled: 1,
    qc_burst_enabled: 1,
    qc_back_entry_enabled: 1,
    created_at: NOW,
  },
  // must_change_password: set when an admin issues a temporary password, and
  // cleared once the person picks their own. Defaulted here rather than left
  // absent, because a missing field would not match the filter that looks for
  // one -- the schemaless trap this file exists to close.
  users: { created_at: NOW, must_change_password: 0 },
  brands: { active: 1 },
  consent_versions: { status: "draft", created_at: NOW },
  questions: { order_index: 0, required: 1, active: 1 },
  skip_rules: { operator: "equals", action: "show" },
  kpi_config: { enabled: 1 },
  respondents: {
    preferred_channel: "app",
    consent_status: "pending",
    activation_status: "invited",
    is_practice: 0,
    biometric_exempt: 0,
    created_at: NOW,
  },
  respondent_profiles: {
    recontact_consent: null,
    created_at: NOW,
    updated_at: NOW,
  },
  respondent_profile_snapshots: { captured_at: NOW },
  whatsapp_sessions: { step: "start", created_at: NOW, updated_at: NOW },
  diary_records: {
    entry_time: NOW,
    channel: "app",
    status: "draft",
    is_practice: 0,
    entry_mode: "standard",
  },
  // source: "respondent" for an answer a person actually gave, "ai_video" for
  // one the video extractor derived. verified: 0 until a researcher confirms
  // it. Defaults matter here -- an unset `source` would silently drop the row
  // out of every filter looking for one (see the schemaless-store note above),
  // and an AI guess that reads as respondent-given is exactly the confusion
  // this field exists to prevent.
  responses: { source: "respondent", verified: 1 },
  media: {
    media_type: "photo",
    upload_time: NOW,
    qc_status: "pending",
    detection_status: "not_run",
    transcript_status: "not_run",
  },
  question_imports: { created_at: NOW },
  qc_flags: { severity: "medium", created_time: NOW, status: "open" },
  reminders: { channel: "whatsapp", scheduled_time: NOW, status: "scheduled" },
  whatsapp_outbox: { provider: "mock", status: "simulated", created_at: NOW },
  audit_log: { created_at: NOW },
  respondent_credentials: { counter: 0, created_at: NOW },
  push_subscriptions: { created_at: NOW },
  ai_summaries: { base_records: 0, base_respondents: 0, used_ai_model: 0, generated_at: NOW },
  respondent_accounts: { created_at: NOW },
  otp_codes: { purpose: "contact_verification", attempts: 0, created_at: NOW },
};

/**
 * Fill in whatever the caller left out.
 *
 * Only genuinely absent fields are filled: an explicit null is a deliberate
 * "no value" and is left alone, exactly as SQLite treated an explicit NULL.
 */
function applyDefaults(collection, doc, now) {
  const defaults = DEFAULTS[collection];
  if (!defaults) return doc;
  const out = { ...doc };
  for (const [field, value] of Object.entries(defaults)) {
    if (out[field] === undefined) out[field] = value === NOW ? now : value;
  }
  return out;
}

module.exports = { DEFAULTS, applyDefaults, NOW };

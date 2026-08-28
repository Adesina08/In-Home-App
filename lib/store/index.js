// The app's data access layer.
//
// Everything above this file speaks in collections, plain filter objects and
// integer ids -- never SQL, and never MongoDB driver types. That is what makes
// it possible to run the same application against a real MongoDB in Azure and
// against a local driver here, and to prove with the same test suite that both
// behave identically.
//
// Two deliberate decisions shape this file:
//
// 1. IDS STAY INTEGERS. Every URL in the app, every foreign key, every export
//    column and every test refers to respondents and entries by small integers.
//    Swapping in ObjectIds would have rewritten all of that for no benefit, so
//    `_id` holds an integer allocated from a `counters` collection, and the
//    rest of the app keeps saying `respondent.id`.
//
// 2. TIMESTAMPS STAY SQLITE-SHAPED. The app compares and sorts times as
//    strings in `YYYY-MM-DD HH:MM:SS` (UTC), which is what SQLite's
//    datetime('now') produced. Switching to Date objects would silently change
//    the meaning of every one of those comparisons, so the format is kept and
//    `nowSql()` is the single place it is produced.

const path = require("path");
const { applyDefaults } = require("./schema");

let driver = null;
let driverName = null;

/** UTC 'YYYY-MM-DD HH:MM:SS' -- the format every stored timestamp uses. */
function nowSql(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);
}

/** Same format, from a Date or a parsable value. */
function toSqlTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// Collections that need an index to stay quick once a study has real volume.
// Declared here rather than in each driver so both create the same ones.
//
// Cosmos DB for MongoDB is stricter than stock MongoDB about ORDER BY: every
// field used for a server-side sort must have an index path. Keep those sort
// fields explicit here as well as the filter/join keys, otherwise a perfectly
// valid Mongo query can fail in Cosmos with "index path ... order-by item is
// excluded". The most important examples are diary_records.entry_time (QC's
// previous-entry lookup) and qc_flags.created_time (newest-first worklists).
const INDEXES = {
  studies: [{ status: 1 }],
  users: [{ email: 1 }, { role: 1 }],
  brands: [{ study_id: 1 }],
  consent_versions: [{ study_id: 1, version: -1 }],
  questions: [{ study_id: 1, order_index: 1 }],
  skip_rules: [{ study_id: 1 }],
  kpi_config: [{ study_id: 1 }],
  respondents: [
    { study_id: 1 },
    { unique_token: 1 },
    { contact: 1 },
    { account_id: 1 },
    { profile_id: 1 },
    { interviewer_id: 1 },
  ],
  respondent_profiles: [
    { account_id: 1 },
    { recontact_consent: 1 },
    { location: 1 },
    { age: 1 },
    { gender: 1 },
    { education_level: 1 },
  ],
  respondent_profile_snapshots: [{ respondent_id: 1 }, { profile_id: 1 }, { study_id: 1 }],
  whatsapp_sessions: [{ contact: 1 }, { respondent_id: 1 }, { updated_at: -1 }],
  diary_records: [
    { study_id: 1 },
    { respondent_id: 1 },
    { status: 1 },
    { entry_time: -1 },
    { occurrence_time: -1 },
    { respondent_id: 1, status: 1, entry_time: -1 },
  ],
  responses: [{ record_id: 1 }, { question_id: 1 }],
  media: [{ record_id: 1 }],
  question_imports: [{ study_id: 1 }],
  qc_flags: [
    { record_id: 1 },
    { respondent_id: 1 },
    { status: 1 },
    { created_time: -1 },
    { respondent_id: 1, status: 1, created_time: -1 },
  ],
  reminders: [{ respondent_id: 1 }, { status: 1 }, { due_time: 1 }],
  whatsapp_outbox: [{ respondent_id: 1 }],
  audit_log: [{ entity: 1, entity_id: 1 }, { created_time: -1 }],
  respondent_credentials: [{ respondent_id: 1 }],
  push_subscriptions: [{ respondent_id: 1 }],
  ai_summaries: [{ study_id: 1 }, { created_at: -1 }],
  respondent_accounts: [{ contact: 1 }],
  otp_codes: [{ contact: 1 }, { expires_at: 1 }],
  // Native Expo access tokens are looked up by a SHA-256 hash on every API
  // request. Index the hash and the ownership/expiry fields so this remains a
  // constant-time lookup as the pilot accumulates devices and re-logins.
  mobile_sessions: [{ token_hash: 1 }, { expires_at: 1 }, { account_id: 1 }, { respondent_id: 1 }],
};

/**
 * Open the database. Called once from server.js (and from scripts) BEFORE
 * anything serves a request -- the rest of the app assumes the connection is
 * already up, exactly as it could when the store was a file on disk.
 */
async function connect(options = {}) {
  if (driver) return driver;

  const uri = options.uri !== undefined ? options.uri : process.env.MONGODB_URI;
  if (uri) {
    driver = require("./mongoDriver").create({
      uri,
      dbName: options.dbName || process.env.MONGODB_DB || "inicio",
    });
    driverName = "mongodb";
  } else {
    // No MONGODB_URI: run against the local driver. It implements the same
    // MongoDB query semantics in-process and persists to a JSON file, so the
    // app is fully usable for development and testing without a server -- but
    // it is NOT the production store, and startup says so out loud rather than
    // letting a deployment quietly run on a local file.
    driver = require("./localDriver").create({
      file: options.file || process.env.LOCAL_DB_PATH || path.join(__dirname, "..", "..", "data.localdb.json"),
    });
    driverName = "local";
  }

  await driver.connect();
  await driver.ensureIndexes(INDEXES);
  return driver;
}

async function close() {
  if (!driver) return;
  await driver.close();
  driver = null;
  driverName = null;
}

function requireDriver() {
  if (!driver) {
    throw new Error("The database has not been opened yet -- call store.connect() during startup.");
  }
  return driver;
}

// ---- The operations the application uses ----
//
// Filters are plain objects using MongoDB's own syntax ({ study_id: 4 },
// { status: { $in: ["draft", "submitted"] } }). Documents come back with `id`
// rather than `_id`, because that is what the rest of the app and every
// template already say.

async function findOne(collection, filter = {}, options = {}) {
  return requireDriver().findOne(collection, filter, options);
}

async function find(collection, filter = {}, options = {}) {
  return requireDriver().find(collection, filter, options);
}

/**
 * Insert one document. Returns { id } -- the allocated integer id.
 *
 * Fields the caller omitted are filled from ./schema.js, which is where the
 * column defaults SQLite used to apply now live. Skipping that step is how a
 * respondent ends up with no consent_status and silently stops matching every
 * query that looks for one.
 */
async function insert(collection, doc) {
  return requireDriver().insert(collection, applyDefaults(collection, doc, nowSql()));
}

/** Update everything matching. Returns { changes } -- rows actually modified. */
async function update(collection, filter, patch) {
  return requireDriver().update(collection, filter, patch);
}

/** Delete everything matching. Returns { changes }. */
async function remove(collection, filter = {}) {
  return requireDriver().remove(collection, filter);
}

async function count(collection, filter = {}) {
  return requireDriver().count(collection, filter);
}

/** Largest value of a field among matching documents, or null if none. */
async function max(collection, field, filter = {}) {
  const rows = await find(collection, filter, { sort: { [field]: -1 }, limit: 1, projection: { [field]: 1 } });
  if (!rows.length) return null;
  const v = rows[0][field];
  return v === undefined ? null : v;
}

/** Distinct values of a field among matching documents. */
async function distinct(collection, field, filter = {}) {
  return requireDriver().distinct(collection, field, filter);
}

/**
 * Group and count in one round trip: returns a plain object keyed by the
 * field's value. Used for the handful of dashboard tallies that would
 * otherwise be one query per key.
 */
async function countBy(collection, field, filter = {}) {
  return requireDriver().countBy(collection, field, filter);
}

/** Wipe a collection -- only the seed and the test helpers use this. */
async function clear(collection) {
  return requireDriver().remove(collection, {});
}

module.exports = {
  connect,
  close,
  nowSql,
  toSqlTime,
  findOne,
  find,
  insert,
  update,
  remove,
  count,
  max,
  distinct,
  countBy,
  clear,
  INDEXES,
  get driverName() {
    return driverName;
  },
};

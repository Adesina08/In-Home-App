// Respondent accounts: the person, separate from their enrolment in any one
// study (see the respondent_accounts table comment in lib/db.js).
//
// Deliberately NOT auto-created for existing respondents. It's tempting to
// backfill an account for every respondent that has a contact, but two things
// make that unsafe:
//
//   * those contacts were never verified -- turning an unverified phone number
//     into a login identity hands account ownership to whoever holds it; and
//   * a household sharing one phone is an allowed case (it's exactly what the
//     duplicate-contact hold exists to let research wave through), so
//     backfilling would silently merge two different people into one account.
//
// Existing respondents therefore keep working through their links exactly as
// before, with account_id null, and an admin links one to an account
// deliberately when it's genuinely the same person.

const db = require("./db");
const { normalizeContact } = require("./otp");

function findByContact(contact) {
  const normalized = normalizeContact(contact);
  if (!normalized) return null;
  return db.prepare("SELECT * FROM respondent_accounts WHERE contact = ?").get(normalized);
}

function getById(id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM respondent_accounts WHERE id = ?").get(id);
}

/**
 * Find the account for this contact, or create it. `name` only fills a blank --
 * a person who typed their name once shouldn't have it overwritten by whatever
 * an admin typed into an invite box later.
 */
function findOrCreate({ contact, name }) {
  const normalized = normalizeContact(contact);
  if (!normalized) throw new Error("A phone number or email is required.");
  const existing = findByContact(normalized);
  if (existing) {
    if (!existing.name && name) {
      db.prepare("UPDATE respondent_accounts SET name = ? WHERE id = ?").run(name, existing.id);
      return getById(existing.id);
    }
    return existing;
  }
  const info = db
    .prepare("INSERT INTO respondent_accounts (name, contact) VALUES (?, ?)")
    .run(name || null, normalized);
  return getById(info.lastInsertRowid);
}

function markVerified(accountId) {
  db.prepare(
    "UPDATE respondent_accounts SET contact_verified_at = COALESCE(contact_verified_at, datetime('now')), last_login_at = datetime('now') WHERE id = ?"
  ).run(accountId);
}

/** Every study this person is enrolled on, newest first. */
function enrolmentsFor(accountId) {
  return db
    .prepare(
      `SELECT r.*, s.name AS study_name, s.status AS study_status, s.diary_mode, s.market, s.category,
              (SELECT COUNT(*) FROM diary_records dr WHERE dr.respondent_id = r.id AND dr.status = 'submitted' AND dr.is_practice = 0) AS submitted_count
       FROM respondents r
       JOIN studies s ON s.id = r.study_id
       WHERE r.account_id = ?
       ORDER BY r.id DESC`
    )
    .all(accountId);
}

/** Is this person already enrolled on this study? */
function enrolmentFor(accountId, studyId) {
  return db
    .prepare("SELECT * FROM respondents WHERE account_id = ? AND study_id = ?")
    .get(accountId, studyId);
}

/**
 * Account sign-up is only offered through a study that actually recruits
 * remotely -- a face-to-face-only study never asks anyone to create a login.
 * (Once someone HAS an account they see every enrolment on it, whatever each
 * study's recruitment mode.)
 */
function accountsAllowedFor(study) {
  return !!study && (study.recruitment_mode === "remote" || study.recruitment_mode === "hybrid");
}

module.exports = {
  findByContact,
  getById,
  findOrCreate,
  markVerified,
  enrolmentsFor,
  enrolmentFor,
  accountsAllowedFor,
};

// Putting one person onto one study.
//
// Three screens now do this -- the single admin invite, the bulk upload, and
// (soon) anything else that recruits -- and they must agree exactly, because
// the differences are the kind that only surface weeks later in the data: a
// respondent with no account attached, a code allocated a different way, a
// consent status that skipped the consent screen.

const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const accounts = require("./respondentAccounts");
const { nextRespondentCode } = require("./respondentCode");

/**
 * Create (or find) the enrolment for this contact on this study.
 *
 * Returns { respondent, account, created }. `created` is false when the
 * person was already enrolled -- callers use that to avoid re-texting someone
 * who is already taking part.
 *
 * Consent is deliberately left pending: it is recorded per study against that
 * study's approved wording, and an invite is not consent.
 */
function enrol({ studyId, contact, name, interviewerId = null, recruitmentMode = "remote" }) {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId);
  if (!study) throw new Error("Study not found.");

  const account = accounts.accountsAllowedFor(study) ? accounts.findOrCreate({ contact, name }) : null;

  if (account) {
    const existing = accounts.enrolmentFor(account.id, study.id);
    if (existing) return { respondent: existing, account, created: false };
  }

  // Someone recruited face-to-face may already be on the study under the same
  // number with no account attached; a second row would split their diary.
  const normalised = String(contact || "").replace(/[\s\-()]/g, "").toLowerCase();
  const sameContact = db
    .prepare(
      `SELECT * FROM respondents
       WHERE study_id = ?
         AND lower(replace(replace(replace(replace(contact,' ',''),'-',''),'(',''),')','')) = ?`
    )
    .get(study.id, normalised);
  if (sameContact) return { respondent: sameContact, account, created: false };

  const token = uuidv4();
  const code = nextRespondentCode(study.id);
  const info = db
    .prepare(
      `INSERT INTO respondents (study_id, respondent_code, name, contact, recruitment_mode, preferred_channel,
         consent_status, activation_status, unique_token, is_practice, account_id, interviewer_id)
       VALUES (?, ?, ?, ?, ?, 'app', 'pending', 'invited', ?, 0, ?, ?)`
    )
    .run(
      study.id, code, (account && account.name) || name || null,
      (account && account.contact) || contact, recruitmentMode, token,
      account ? account.id : null, interviewerId
    );

  return {
    respondent: db.prepare("SELECT * FROM respondents WHERE id = ?").get(info.lastInsertRowid),
    account,
    created: true,
  };
}

/** Contacts already on a study, normalised for comparison against a roster. */
function existingContactsFor(studyId) {
  return db
    .prepare("SELECT contact FROM respondents WHERE study_id = ? AND contact IS NOT NULL")
    .all(studyId)
    .map((r) => String(r.contact).replace(/[\s\-()]/g, ""));
}

module.exports = { enrol, existingContactsFor };

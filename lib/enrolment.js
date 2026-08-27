// Putting one person onto one study.
//
// Three screens now do this -- the single admin invite, the bulk upload, and
// (soon) anything else that recruits -- and they must agree exactly, because
// the differences are the kind that only surface weeks later in the data: a
// respondent with no account attached, a code allocated a different way, a
// consent status that skipped the consent screen.

const { v4: uuidv4 } = require("uuid");
const store = require("./store");
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
async function enrol({ studyId, contact, name, interviewerId = null, recruitmentMode = "remote" }) {
  const study = await store.findOne("studies", { id: studyId });
  if (!study) throw new Error("Study not found.");

  const account = accounts.accountsAllowedFor(study) ? await accounts.findOrCreate({ contact, name }) : null;

  if (account) {
    const existing = await accounts.enrolmentFor(account.id, study.id);
    if (existing) return { respondent: existing, account, created: false };
  }

  // Someone recruited face-to-face may already be on the study under the same
  // number with no account attached; a second row would split their diary.
  //
  // This match was a SQL lower(replace(replace(replace(replace(contact,...)))))
  // comparison. MongoDB has no string functions to run inside a filter, so the
  // study's respondents are fetched and normalised in JS instead -- same rules
  // as before: strip spaces, hyphens and parentheses, then lowercase. Rows are
  // taken in id order so the first match is the same row `.get()` returned, and
  // a NULL contact is skipped because `NULL = ?` was never true in SQL (without
  // that guard a contactless respondent would normalise to "" and collide).
  const normalised = String(contact || "").replace(/[\s\-()]/g, "").toLowerCase();
  const candidates = await store.find("respondents", { study_id: study.id }, { sort: { id: 1 } });
  const sameContact = candidates.find(
    (r) =>
      r.contact !== null &&
      r.contact !== undefined &&
      String(r.contact).replace(/[\s\-()]/g, "").toLowerCase() === normalised
  );
  if (sameContact) return { respondent: sameContact, account, created: false };

  const token = uuidv4();
  const code = await nextRespondentCode(study.id);
  const { id } = await store.insert("respondents", {
    study_id: study.id,
    respondent_code: code,
    name: (account && account.name) || name || null,
    contact: (account && account.contact) || contact,
    recruitment_mode: recruitmentMode,
    preferred_channel: "app",
    consent_status: "pending",
    activation_status: "invited",
    unique_token: token,
    is_practice: 0,
    account_id: account ? account.id : null,
    interviewer_id: interviewerId,
  });

  return {
    respondent: await store.findOne("respondents", { id }),
    account,
    created: true,
  };
}

/** Contacts already on a study, normalised for comparison against a roster. */
async function existingContactsFor(studyId) {
  const rows = await store.find(
    "respondents",
    { study_id: studyId, contact: { $ne: null } },
    { sort: { id: 1 }, projection: { contact: 1 } }
  );
  return rows.map((r) => String(r.contact).replace(/[\s\-()]/g, ""));
}

module.exports = { enrol, existingContactsFor };

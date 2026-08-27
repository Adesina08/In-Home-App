// Respondent accounts: the person, separate from their enrolment in any one
// study (see the respondent_accounts defaults in lib/store/schema.js).
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

const store = require("./store");
const { normalizeContact } = require("./otp");

async function findByContact(contact) {
  const normalized = normalizeContact(contact);
  if (!normalized) return null;
  return store.findOne("respondent_accounts", { contact: normalized });
}

async function getById(id) {
  if (!id) return null;
  return store.findOne("respondent_accounts", { id });
}

/**
 * Find the account for this contact, or create it. `name` only fills a blank --
 * a person who typed their name once shouldn't have it overwritten by whatever
 * an admin typed into an invite box later.
 */
async function findOrCreate({ contact, name }) {
  const normalized = normalizeContact(contact);
  if (!normalized) throw new Error("A phone number or email is required.");
  const existing = await findByContact(normalized);
  if (existing) {
    if (!existing.name && name) {
      await store.update("respondent_accounts", { id: existing.id }, { name });
      return getById(existing.id);
    }
    return existing;
  }
  const { id } = await store.insert("respondent_accounts", { name: name || null, contact: normalized });
  return getById(id);
}

async function markVerified(accountId) {
  // COALESCE(contact_verified_at, datetime('now')) done in JS: the first
  // verification stamps the column, every later login leaves it as it was.
  const existing = await store.findOne("respondent_accounts", { id: accountId });
  if (!existing) return;
  const now = store.nowSql();
  await store.update(
    "respondent_accounts",
    { id: accountId },
    { contact_verified_at: existing.contact_verified_at || now, last_login_at: now }
  );
}

/** Every study this person is enrolled on, newest first. */
async function enrolmentsFor(accountId) {
  // The JOIN onto studies and the correlated submitted_count are done in JS --
  // the store has no joins. The aliased names (study_name, study_status,
  // submitted_count) are kept exactly, because the templates read them.
  const rows = await store.find("respondents", { account_id: accountId }, { sort: { id: -1 } });
  const studies = await store.find("studies", {});
  const byId = new Map(studies.map((s) => [s.id, s]));
  const out = [];
  for (const r of rows) {
    const s = byId.get(r.study_id);
    // An inner join dropped a respondent whose study was missing; keep that.
    if (!s) continue;
    const submittedCount = await store.count("diary_records", {
      respondent_id: r.id,
      status: "submitted",
      is_practice: 0,
    });
    out.push({
      ...r,
      study_name: s.name,
      study_status: s.status,
      diary_mode: s.diary_mode,
      market: s.market,
      category: s.category,
      submitted_count: submittedCount,
    });
  }
  return out;
}

/** Is this person already enrolled on this study? */
async function enrolmentFor(accountId, studyId) {
  return store.findOne("respondents", { account_id: accountId, study_id: studyId });
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

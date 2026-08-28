// Respondent accounts: one reusable Inicio Diary identity across study enrolments.
const bcrypt = require("bcryptjs");
const store = require("./store");
const { normalizeContact } = require("./otp");

async function findByContact(contact) {
  const normalized = normalizeContact(contact);
  if (!normalized) return null;
  return store.findOne("respondent_accounts", { contact: normalized });
}

async function findByUsername(username) {
  const normalized = String(username || "").trim().toLowerCase();
  if (!normalized) return null;
  return store.findOne("respondent_accounts", { username: normalized });
}

async function getById(id) {
  if (!id) return null;
  return store.findOne("respondent_accounts", { id });
}

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

async function setCredentials(accountId, { username, password }) {
  const normalized = String(username || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{4,40}$/.test(normalized)) {
    const error = new Error("Username must be 4–40 characters using letters, numbers, dots, dashes or underscores.");
    error.code = "INVALID_USERNAME";
    throw error;
  }
  if (String(password || "").length < 8) {
    const error = new Error("Password must be at least 8 characters.");
    error.code = "WEAK_PASSWORD";
    throw error;
  }
  const owner = await findByUsername(normalized);
  if (owner && owner.id !== accountId) {
    const error = new Error("That username is already in use. Please choose another one.");
    error.code = "USERNAME_TAKEN";
    throw error;
  }
  const passwordHash = await bcrypt.hash(String(password), 12);
  await store.update("respondent_accounts", { id: accountId }, {
    username: normalized,
    password_hash: passwordHash,
    credentials_created_at: store.nowSql(),
  });
  return getById(accountId);
}

async function verifyCredentials(username, password) {
  const account = await findByUsername(username);
  if (!account || !account.password_hash) return null;
  const ok = await bcrypt.compare(String(password || ""), account.password_hash);
  return ok ? account : null;
}

async function markVerified(accountId) {
  const existing = await store.findOne("respondent_accounts", { id: accountId });
  if (!existing) return;
  const now = store.nowSql();
  await store.update("respondent_accounts", { id: accountId }, {
    contact_verified_at: existing.contact_verified_at || now,
    last_login_at: now,
  });
}

async function enrolmentsFor(accountId) {
  const rows = await store.find("respondents", { account_id: accountId }, { sort: { id: -1 } });
  const studies = await store.find("studies", {});
  const byId = new Map(studies.map((s) => [s.id, s]));
  const out = [];
  for (const r of rows) {
    const s = byId.get(r.study_id);
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

async function enrolmentFor(accountId, studyId) {
  return store.findOne("respondents", { account_id: accountId, study_id: studyId });
}

function accountsAllowedFor(study) {
  return !!study && (study.recruitment_mode === "remote" || study.recruitment_mode === "hybrid");
}

module.exports = {
  findByContact,
  findByUsername,
  getById,
  findOrCreate,
  setCredentials,
  verifyCredentials,
  markVerified,
  enrolmentsFor,
  enrolmentFor,
  accountsAllowedFor,
};

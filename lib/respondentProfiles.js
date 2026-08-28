const store = require("./store");

// One INICIO person can participate in many studies. Demographics live here,
// outside the study-specific respondents collection, so a returning person is
// not asked the same pre-survey again and can be invited to another study.
// Study-specific consent and status remain on respondents.
const PROFILE_FIELDS = [
  "name",
  "location",
  "age",
  "gender",
  "education_level",
  "occupation",
  "religion",
  "marital_status",
  "recontact_consent",
];

const GENDER_OPTIONS = ["male", "female", "other", "prefer_not_to_say"];
const EDUCATION_OPTIONS = [
  "no_formal_schooling",
  "primary",
  "secondary",
  "vocational_technical",
  "tertiary_university",
  "postgraduate",
  "other",
  "prefer_not_to_say",
];
const MARITAL_OPTIONS = [
  "single",
  "married",
  "living_with_partner",
  "separated",
  "divorced",
  "widowed",
  "other",
  "prefer_not_to_say",
];

function cleanText(value) {
  return value == null ? "" : String(value).trim();
}

function normalize(values = {}) {
  const ageRaw = cleanText(values.age);
  const age = ageRaw === "" ? null : Number(ageRaw);
  return {
    name: cleanText(values.name),
    location: cleanText(values.location),
    age: Number.isFinite(age) ? Math.trunc(age) : null,
    gender: cleanText(values.gender).toLowerCase(),
    education_level: cleanText(values.education_level).toLowerCase(),
    occupation: cleanText(values.occupation),
    religion: cleanText(values.religion),
    marital_status: cleanText(values.marital_status).toLowerCase(),
    recontact_consent: cleanText(values.recontact_consent).toLowerCase(),
  };
}

function validate(values = {}) {
  const v = normalize(values);
  const errors = {};
  if (!v.name) errors.name = "Enter your name.";
  if (!v.location) errors.location = "Enter where you currently live.";
  if (!Number.isInteger(v.age) || v.age < 1 || v.age > 120) errors.age = "Enter a valid age.";
  if (!GENDER_OPTIONS.includes(v.gender)) errors.gender = "Choose a gender option.";
  if (!EDUCATION_OPTIONS.includes(v.education_level)) errors.education_level = "Choose your highest level of education.";
  if (!v.occupation) errors.occupation = "Enter your occupation. You can enter 'Not currently working' where appropriate.";
  if (!v.religion) errors.religion = "Enter your religion, or choose 'Prefer not to say'.";
  if (!MARITAL_OPTIONS.includes(v.marital_status)) errors.marital_status = "Choose a marital-status option.";
  if (!["yes", "no"].includes(v.recontact_consent)) errors.recontact_consent = "Choose whether INICIO may contact you about future studies.";
  return { values: v, errors, ok: Object.keys(errors).length === 0 };
}

function publicProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name || null,
    location: profile.location || null,
    age: profile.age == null ? null : profile.age,
    gender: profile.gender || null,
    educationLevel: profile.education_level || null,
    occupation: profile.occupation || null,
    religion: profile.religion || null,
    maritalStatus: profile.marital_status || null,
    recontactConsent: profile.recontact_consent || null,
    completed: !!profile.completed_at,
    completedAt: profile.completed_at || null,
    updatedAt: profile.updated_at || null,
  };
}

async function getById(id) {
  if (!id) return null;
  return store.findOne("respondent_profiles", { id: Number(id) });
}

async function getForAccount(accountId) {
  if (!accountId) return null;
  return store.findOne("respondent_profiles", { account_id: Number(accountId) });
}

async function ensureForAccount(account) {
  if (!account || !account.id) return null;
  let profile = await getForAccount(account.id);
  if (profile) return profile;
  const { id } = await store.insert("respondent_profiles", {
    account_id: account.id,
    name: null,
  });
  return getById(id);
}

async function ensureForRespondent(respondent) {
  if (!respondent) return null;
  if (respondent.profile_id) {
    const existing = await getById(respondent.profile_id);
    if (existing) return existing;
  }

  let profile = null;
  if (respondent.account_id) profile = await getForAccount(respondent.account_id);
  if (!profile) {
    const { id } = await store.insert("respondent_profiles", {
      account_id: respondent.account_id || null,
      // Do not silently count the name on the invitation as the one-time
      // pre-survey answer. The form may prefill it, but the person confirms it.
      name: null,
    });
    profile = await getById(id);
  }
  await store.update("respondents", { id: respondent.id }, { profile_id: profile.id });
  return profile;
}

// Called only after identity has been verified (OTP or the person's own
// WhatsApp sender number). It intentionally does not merge profiles merely
// because two unverified enrolments share a phone number: shared household
// phones are a valid recruitment case in this app.
async function linkVerifiedAccount(respondent, account) {
  if (!respondent || !account) return null;
  const localProfile = respondent.profile_id ? await getById(respondent.profile_id) : null;
  let accountProfile = await getForAccount(account.id);

  if (!accountProfile && localProfile) {
    await store.update("respondent_profiles", { id: localProfile.id }, { account_id: account.id, updated_at: store.nowSql() });
    accountProfile = await getById(localProfile.id);
  } else if (!accountProfile) {
    accountProfile = await ensureForAccount(account);
  } else if (localProfile && localProfile.id !== accountProfile.id && localProfile.completed_at && !accountProfile.completed_at) {
    // A link-only/F2F respondent may have completed the one-time profile before
    // later verifying an account. Preserve those answers when the identities
    // are joined instead of asking the survey again.
    const patch = {};
    for (const field of PROFILE_FIELDS) patch[field] = localProfile[field] == null ? null : localProfile[field];
    patch.completed_at = localProfile.completed_at;
    patch.updated_at = store.nowSql();
    await store.update("respondent_profiles", { id: accountProfile.id }, patch);
    accountProfile = await getById(accountProfile.id);
  }

  await store.update("respondents", { id: respondent.id }, { account_id: account.id, profile_id: accountProfile.id });
  // Any other enrolments already verified to this same account should use the
  // same panel profile too.
  await store.update("respondents", { account_id: account.id }, { profile_id: accountProfile.id });
  return accountProfile;
}

async function completeProfile(profileId, input) {
  const checked = validate(input);
  if (!checked.ok) return checked;
  const patch = {
    ...checked.values,
    completed_at: store.nowSql(),
    updated_at: store.nowSql(),
  };
  await store.update("respondent_profiles", { id: Number(profileId) }, patch);
  const profile = await getById(profileId);
  if (profile && profile.account_id && profile.name) {
    // Keep the respondent-account display name aligned with the person's
    // confirmed profile name; this does not change the verified login contact.
    await store.update("respondent_accounts", { id: profile.account_id }, { name: profile.name });
    await store.update("respondents", { account_id: profile.account_id }, { name: profile.name, profile_id: profile.id });
  }
  return { ok: true, errors: {}, values: checked.values, profile };
}

async function patchProfile(profileId, patch) {
  const allowed = {};
  for (const field of PROFILE_FIELDS) {
    if (patch[field] !== undefined) allowed[field] = patch[field];
  }
  allowed.updated_at = store.nowSql();
  await store.update("respondent_profiles", { id: Number(profileId) }, allowed);
  return getById(profileId);
}

async function ensureStudySnapshot(respondent) {
  if (!respondent) return null;
  const existing = await store.findOne("respondent_profile_snapshots", { respondent_id: respondent.id });
  if (existing) return existing;
  const profile = await ensureForRespondent(respondent);
  if (!profile || !profile.completed_at) return null;
  const snapshot = {};
  for (const field of PROFILE_FIELDS) snapshot[field] = profile[field] == null ? null : profile[field];
  const { id } = await store.insert("respondent_profile_snapshots", {
    profile_id: profile.id,
    respondent_id: respondent.id,
    study_id: respondent.study_id,
    snapshot_json: JSON.stringify(snapshot),
    captured_at: store.nowSql(),
  });
  return store.findOne("respondent_profile_snapshots", { id });
}

module.exports = {
  PROFILE_FIELDS,
  GENDER_OPTIONS,
  EDUCATION_OPTIONS,
  MARITAL_OPTIONS,
  normalize,
  validate,
  publicProfile,
  getById,
  getForAccount,
  ensureForAccount,
  ensureForRespondent,
  linkVerifiedAccount,
  completeProfile,
  patchProfile,
  ensureStudySnapshot,
};

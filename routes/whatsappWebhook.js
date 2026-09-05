const express = require("express");
const crypto = require("crypto");
const store = require("../lib/store");
const accounts = require("../lib/respondentAccounts");
const profiles = require("../lib/respondentProfiles");
const { normalizeContact } = require("../lib/otp");
const { logAudit } = require("../lib/audit");

const router = express.Router();

function xmlEscape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function reply(res, message) {
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`);
}

function senderContact(req) {
  return normalizeContact(String(req.body.From || "").replace(/^whatsapp:/i, ""));
}

function verifyTwilioSignature(req) {
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!authToken || String(process.env.VERIFY_TWILIO_WEBHOOKS || "true").toLowerCase() === "false") return true;
  const supplied = String(req.get("x-twilio-signature") || "");
  if (!supplied) return false;

  const base = String(process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  let material = `${base}${req.originalUrl}`;
  for (const key of Object.keys(req.body || {}).sort()) material += `${key}${req.body[key]}`;
  const expected = crypto.createHmac("sha1", authToken).update(material).digest("base64");
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sessionFor(contact) {
  return store.findOne("whatsapp_sessions", { contact });
}

async function saveSession(contact, patch) {
  const existing = await sessionFor(contact);
  const next = { ...patch, contact, updated_at: store.nowSql() };
  if (existing) {
    await store.update("whatsapp_sessions", { id: existing.id }, next);
    return store.findOne("whatsapp_sessions", { id: existing.id });
  }
  const { id } = await store.insert("whatsapp_sessions", next);
  return store.findOne("whatsapp_sessions", { id });
}

const PROFILE_STEPS = [
  {
    key: "name",
    prompt: "Before we begin, we'd like to know a little about you. You only complete this INICIO profile once.\n\n1/9 What is your name?",
    parse: (v) => v.trim() ? { ok: true, value: v.trim() } : { ok: false, error: "Please enter your name." },
  },
  {
    key: "location",
    prompt: "2/9 Where do you currently live? Reply with your city, state or area.",
    parse: (v) => v.trim() ? { ok: true, value: v.trim() } : { ok: false, error: "Please enter where you currently live." },
  },
  {
    key: "age",
    prompt: "3/9 How old are you? Reply with your age in years.",
    parse: (v) => {
      const n = Number(v.trim());
      return Number.isInteger(n) && n >= 1 && n <= 120 ? { ok: true, value: n } : { ok: false, error: "Please reply with a valid age in years." };
    },
  },
  {
    key: "gender",
    prompt: "4/9 What is your gender?\n1 Male\n2 Female\n3 Other\n4 Prefer not to say",
    parse: (v) => choice(v, { "1": "male", male: "male", "2": "female", female: "female", "3": "other", other: "other", "4": "prefer_not_to_say", "prefer not to say": "prefer_not_to_say" }, "Please reply 1, 2, 3 or 4."),
  },
  {
    key: "education_level",
    prompt: "5/9 What is the highest level of education you completed?\n1 No formal schooling\n2 Primary\n3 Secondary\n4 Vocational / technical\n5 Tertiary / university\n6 Postgraduate\n7 Other\n8 Prefer not to say",
    parse: (v) => choice(v, {
      "1": "no_formal_schooling", "2": "primary", "3": "secondary", "4": "vocational_technical",
      "5": "tertiary_university", "6": "postgraduate", "7": "other", "8": "prefer_not_to_say",
    }, "Please reply with a number from 1 to 8."),
  },
  {
    key: "occupation",
    prompt: "6/9 What is your occupation? You can also reply Student, Retired, Homemaker, or Not currently working.",
    parse: (v) => v.trim() ? { ok: true, value: v.trim() } : { ok: false, error: "Please enter your occupation." },
  },
  {
    key: "religion",
    prompt: "7/9 What is your religion? You may reply 'Prefer not to say'.",
    parse: (v) => v.trim() ? { ok: true, value: v.trim() } : { ok: false, error: "Please enter your religion or reply 'Prefer not to say'." },
  },
  {
    key: "marital_status",
    prompt: "8/9 What is your marital status?\n1 Single\n2 Married\n3 Living with partner\n4 Separated\n5 Divorced\n6 Widowed\n7 Other\n8 Prefer not to say",
    parse: (v) => choice(v, {
      "1": "single", "2": "married", "3": "living_with_partner", "4": "separated",
      "5": "divorced", "6": "widowed", "7": "other", "8": "prefer_not_to_say",
    }, "Please reply with a number from 1 to 8."),
  },
  {
    key: "recontact_consent",
    prompt: "9/9 May INICIO contact you about suitable future research studies? This is separate from consent for this study.\n1 Yes\n2 No",
    parse: (v) => choice(v, { "1": "yes", yes: "yes", y: "yes", "2": "no", no: "no", n: "no" }, "Please reply 1 for Yes or 2 for No."),
  },
];

function choice(value, map, error) {
  const key = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(map, key) ? { ok: true, value: map[key] } : { ok: false, error };
}

function profileInput(profile) {
  return {
    name: profile.name,
    location: profile.location,
    age: profile.age,
    gender: profile.gender,
    education_level: profile.education_level,
    occupation: profile.occupation,
    religion: profile.religion,
    marital_status: profile.marital_status,
    recontact_consent: profile.recontact_consent,
  };
}

async function consentPrompt(respondent) {
  const study = await store.findOne("studies", { id: respondent.study_id });
  const consent = await store.findOne(
    "consent_versions",
    { study_id: respondent.study_id, status: "approved" },
    { sort: { version: -1 } }
  );
  if (!study || !consent) return { ready: false, message: "This study is not ready for WhatsApp onboarding yet. Please contact the study team." };
  const body = String(consent.body || "").trim();
  const shortened = body.length > 1200 ? `${body.slice(0, 1197)}...` : body;
  return {
    ready: true,
    message: `Your INICIO profile is complete. Now we need consent for this study specifically.\n\n${study.name}\n\n${shortened}\n\nReply YES to take part in this study, or NO to decline.`,
  };
}

async function startInvite(contact, token) {
  let respondent = await store.findOne("respondents", { unique_token: token });
  if (!respondent) return { message: "That INICIO invitation is not valid. Please reopen the invitation link and choose WhatsApp again." };

  const existingVerified = respondent.contact_verified_at && respondent.contact
    ? normalizeContact(respondent.contact)
    : null;
  if (existingVerified && existingVerified !== contact) {
    return { message: "This invitation is already linked to a different verified contact. Please ask the study team for help." };
  }

  const account = await accounts.findOrCreate({ contact, name: respondent.name || null });
  await accounts.markVerified(account.id);
  await store.update("respondents", { id: respondent.id }, {
    account_id: account.id,
    contact,
    contact_verified_at: store.nowSql(),
    chosen_mode: "whatsapp",
    preferred_channel: "whatsapp",
  });
  respondent = await store.findOne("respondents", { id: respondent.id });
  const profile = await profiles.linkVerifiedAccount(respondent, account);

  if (profile && profile.completed_at) {
    const consent = await consentPrompt(respondent);
    if (!consent.ready) return { message: consent.message };
    await saveSession(contact, { respondent_id: respondent.id, profile_id: profile.id, step: "study_consent", profile_index: null });
    return { message: `Welcome back${profile.name ? `, ${profile.name.split(" ")[0]}` : ""}. We already have your one-time INICIO profile, so you do not need to answer those questions again.\n\n${consent.message}` };
  }

  await saveSession(contact, { respondent_id: respondent.id, profile_id: profile.id, step: "profile", profile_index: 0 });
  return { message: PROFILE_STEPS[0].prompt };
}

async function handleProfile(contact, session, body) {
  const index = Number(session.profile_index || 0);
  const step = PROFILE_STEPS[index];
  if (!step) return { message: "Please reopen your INICIO invitation and choose WhatsApp again." };

  const parsed = step.parse(body);
  if (!parsed.ok) return { message: `${parsed.error}\n\n${step.prompt}` };
  await profiles.patchProfile(session.profile_id, { [step.key]: parsed.value });

  const nextIndex = index + 1;
  if (nextIndex < PROFILE_STEPS.length) {
    await saveSession(contact, { profile_index: nextIndex, step: "profile" });
    return { message: PROFILE_STEPS[nextIndex].prompt };
  }

  const current = await profiles.getById(session.profile_id);
  const completed = await profiles.completeProfile(session.profile_id, profileInput(current));
  if (!completed.ok) {
    // This should only happen if data was externally edited mid-conversation.
    // Restart cleanly instead of silently marking an incomplete profile done.
    await saveSession(contact, { profile_index: 0, step: "profile" });
    return { message: `We couldn't finish your profile because one answer is missing. Let's check it again.\n\n${PROFILE_STEPS[0].prompt}` };
  }

  const respondent = await store.findOne("respondents", { id: session.respondent_id });
  await store.update("respondents", { id: respondent.id }, { profile_id: completed.profile.id, name: completed.profile.name });
  logAudit(`respondent:${respondent.id}`, "profile_completed", "respondent_profiles", completed.profile.id, {
    channel: "whatsapp",
    recontact_consent: completed.profile.recontact_consent,
  });

  const consent = await consentPrompt(respondent);
  if (!consent.ready) return { message: consent.message };
  await saveSession(contact, { step: "study_consent", profile_index: null });
  return { message: `Thanks${completed.profile.name ? `, ${completed.profile.name.split(" ")[0]}` : ""}. ${consent.message}` };
}

async function handleStudyConsent(contact, session, body) {
  const answer = String(body || "").trim().toLowerCase();
  const respondent = await store.findOne("respondents", { id: session.respondent_id });
  if (!respondent) return { message: "We couldn't find your study enrolment. Please reopen your invitation." };

  if (["no", "n", "2"].includes(answer)) {
    await store.update("respondents", { id: respondent.id }, {
      activation_status: "disqualified",
      disqualify_reason: "Declined study consent in WhatsApp",
      disqualified_at: store.nowSql(),
    });
    await saveSession(contact, { step: "declined" });
    logAudit(`respondent:${respondent.id}`, "whatsapp_consent_declined", "respondents", respondent.id, {});
    return { message: "Understood. You will not take part in this study. Your choice has been saved." };
  }

  if (!["yes", "y", "1"].includes(answer)) {
    return { message: "Please reply YES to take part in this study, or NO to decline." };
  }

  const nextStatus = respondent.activation_status === "registered" ? "registered" : "activated";
  await store.update("respondents", { id: respondent.id }, {
    consent_status: "given",
    activation_status: nextStatus,
    preferred_channel: "whatsapp",
    chosen_mode: "whatsapp",
  });
  const refreshed = await store.findOne("respondents", { id: respondent.id });
  await profiles.ensureStudySnapshot(refreshed);
  await saveSession(contact, { step: "ready" });
  logAudit(`respondent:${respondent.id}`, "whatsapp_consent_given", "respondents", respondent.id, {});

  const study = await store.findOne("studies", { id: respondent.study_id });
  return {
    message: `Thank you. You're enrolled in ${study ? study.name : "the study"} and WhatsApp is your preferred channel. The study team can now send your diary reminders and prompts here.`,
  };
}

router.post("/", async (req, res) => {
  if (!verifyTwilioSignature(req)) return res.status(403).send("Invalid Twilio signature");
  const contact = senderContact(req);
  if (!contact) return reply(res, "We couldn't read your WhatsApp number. Please contact the study team.");
  const body = String(req.body.Body || "").trim();

  const join = /^JOIN\s+(.+)$/i.exec(body);
  if (join) {
    const token = String(join[1] || "").trim().replace(/^.*\/invite\//, "").split(/[?#]/)[0];
    const result = await startInvite(contact, token);
    return reply(res, result.message);
  }

  const session = await sessionFor(contact);
  if (!session) {
    return reply(res, "To begin, open your INICIO invitation and choose WhatsApp. It will start this chat with your study invitation automatically.");
  }

  let result;
  if (session.step === "profile") result = await handleProfile(contact, session, body);
  else if (session.step === "study_consent") result = await handleStudyConsent(contact, session, body);
  else if (session.step === "ready") result = { message: "You're already enrolled. Your study team will send study messages to this WhatsApp number." };
  else if (session.step === "declined") result = { message: "You previously declined this study. Contact the study team if you want to change that choice." };
  else result = { message: "Please reopen your INICIO invitation and choose WhatsApp again." };

  reply(res, result.message);
});

module.exports = router;

const express = require("express");
const crypto = require("crypto");
const store = require("../lib/store");
const accounts = require("../lib/respondentAccounts");
const profiles = require("../lib/respondentProfiles");
const { normalizeContact } = require("../lib/otp");
const { logAudit } = require("../lib/audit");
const whatsappDiary = require("../lib/whatsappDiary");
const whatsappFlow = require("../lib/whatsappFlow");
const messaging = require("../lib/whatsapp");

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

function inboundMedia(req) {
  const count = Math.min(10, Math.max(0, Number(req.body.NumMedia) || 0));
  return Array.from({ length: count }, (_, index) => ({
    url: String(req.body[`MediaUrl${index}`] || ""),
    contentType: String(req.body[`MediaContentType${index}`] || ""),
  })).filter((item) => item.url);
}

// lib/whatsappDiary.js returns either a plain string (every case the typed
// flow already handles) or, only for an eligible single-select question, an
// { prompt, question, options } signal -- see questionResult() there.
function diaryOutcome(value) {
  return typeof value === "string" ? { message: value } : { message: value.prompt, listPicker: value };
}

function listPickerVariables(question, options) {
  const vars = { "1": String(question.text || "").slice(0, 1024) };
  options.forEach((option, index) => { vars[String(index + 2)] = String(option).slice(0, 24); });
  return vars;
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

async function rememberedInbound(messageSid) {
  if (!messageSid) return null;
  return store.findOne("whatsapp_inbound_messages", { message_sid: messageSid });
}

async function rememberInbound(messageSid, contact, respondentId, message) {
  if (!messageSid || await rememberedInbound(messageSid)) return;
  await store.insert("whatsapp_inbound_messages", {
    message_sid: messageSid,
    contact,
    respondent_id: respondentId || null,
    reply: message,
  });
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
      return Number.isInteger(n) && n >= 18 && n <= 70 ? { ok: true, value: n } : { ok: false, error: "Please reply with an age between 18 and 70." };
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

async function currentConsent(respondent) {
  if (!respondent || respondent.consent_status !== "given") return null;
  const consent = await store.findOne(
    "consent_versions",
    { study_id: respondent.study_id, status: "approved" },
    { sort: { version: -1 } }
  );
  return consent && Number(respondent.consent_version) === Number(consent.version) ? consent : null;
}

function missingProfileIndex(profile, after = -1) {
  for (let index = after + 1; index < PROFILE_STEPS.length; index += 1) {
    const value = profile ? profile[PROFILE_STEPS[index].key] : null;
    if (value === undefined || value === null || String(value).trim() === "") return index;
  }
  return -1;
}

async function finishOnboarding(contact, respondent, profile, welcome = "Thank you") {
  await profiles.ensureStudySnapshot({ ...respondent, profile_id: profile.id });
  await saveSession(contact, {
    respondent_id: respondent.id,
    profile_id: profile.id,
    step: "ready",
    profile_index: null,
  });
  const study = await store.findOne("studies", { id: respondent.study_id });
  return `${welcome}. You're ready to take part in ${study ? study.name : "the study"} through WhatsApp. Reply DIARY to start an entry, STATUS for your progress, or MENU for help.`;
}

async function startInvite(contact, token) {
  let respondent = await store.findOne("respondents", { unique_token: token });
  if (!respondent) return { message: "That INICIO invitation is not valid. Please reopen the invitation link and choose WhatsApp again." };

  // JOIN is only a handoff from the completed browser journey. A token copied
  // into WhatsApp must never bypass consent, the study pre-survey, exact-contact
  // verification, or the explicit participation-method choice.
  if (!await currentConsent(respondent)) {
    return { message: "Please reopen your INICIO invitation and complete the current study consent before continuing in WhatsApp." };
  }
  if (!respondent.presurvey_completed_at) {
    return { message: "Please reopen your INICIO invitation and complete the pre-survey before continuing in WhatsApp." };
  }
  if (!respondent.contact_verified_at || !respondent.contact) {
    return { message: "Please reopen your INICIO invitation and verify your phone number before continuing in WhatsApp." };
  }
  if (respondent.chosen_mode !== "whatsapp") {
    return { message: "Please reopen your INICIO invitation and choose WhatsApp as your participation method first." };
  }
  const existingVerified = normalizeContact(respondent.contact);
  if (existingVerified !== contact) {
    return { message: "This invitation is linked to a different verified phone number. Open it using that number or ask the study team for help." };
  }

  const existingSession = await sessionFor(contact);
  if (existingSession && existingSession.respondent_id && existingSession.respondent_id !== respondent.id && ["diary", "paused_diary", "closeout", "paused_closeout", "stop_confirm"].includes(existingSession.step)) {
    return { message: "You already have a diary entry in progress for another study. Reply CONTINUE to finish it or CANCEL to discard it before switching studies." };
  }

  const account = await accounts.findOrCreate({ contact, name: respondent.name || null });
  await accounts.markVerified(account.id);
  await store.update("respondents", { id: respondent.id }, {
    account_id: account.id,
    chosen_mode: "whatsapp",
    preferred_channel: "whatsapp",
    ...(["invited", "screened"].includes(respondent.activation_status)
      ? { activation_status: "activated", activated_at: store.nowSql() }
      : {}),
  });
  respondent = await store.findOne("respondents", { id: respondent.id });
  let profile = await profiles.linkVerifiedAccount(respondent, account);

  // The browser has already collected and verified the respondent's name. Use
  // it instead of asking the same question again in chat.
  if (profile && !profile.name && respondent.name) {
    profile = await profiles.patchProfile(profile.id, { name: respondent.name });
  }

  if (profile && profile.completed_at) {
    return { message: await finishOnboarding(contact, respondent, profile, `Welcome back${profile.name ? `, ${profile.name.split(" ")[0]}` : ""}`) };
  }

  const nextIndex = missingProfileIndex(profile);
  if (nextIndex < 0) {
    const completed = await profiles.completeProfile(profile.id, profileInput(profile));
    if (completed.ok) return { message: await finishOnboarding(contact, respondent, completed.profile) };
  }
  await saveSession(contact, { respondent_id: respondent.id, profile_id: profile.id, step: "profile", profile_index: nextIndex });
  const intro = nextIndex === 0
    ? "Before we begin, please complete your one-time INICIO profile."
    : "We'll use the name you already gave us. Please complete the remaining fields in your one-time INICIO profile.";
  return { message: `${intro}\n\n${PROFILE_STEPS[nextIndex].prompt}` };
}

async function handleProfile(contact, session, body) {
  const index = Number(session.profile_index || 0);
  const step = PROFILE_STEPS[index];
  if (!step) return { message: "Please reopen your INICIO invitation and choose WhatsApp again." };

  const parsed = step.parse(body);
  if (!parsed.ok) return { message: `${parsed.error}\n\n${step.prompt}` };
  await profiles.patchProfile(session.profile_id, { [step.key]: parsed.value });

  const updatedProfile = await profiles.getById(session.profile_id);
  const nextIndex = missingProfileIndex(updatedProfile, index);
  if (nextIndex >= 0) {
    await saveSession(contact, { profile_index: nextIndex, step: "profile" });
    return { message: PROFILE_STEPS[nextIndex].prompt };
  }

  const completed = await profiles.completeProfile(session.profile_id, profileInput(updatedProfile));
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

  if (!await currentConsent(respondent)) {
    await saveSession(contact, { step: "needs_browser", profile_index: null });
    return { message: "Your profile is saved, but the study consent has changed. Please reopen your invitation and review the current wording before continuing." };
  }
  return { message: await finishOnboarding(contact, respondent, completed.profile, `Thanks${completed.profile.name ? `, ${completed.profile.name.split(" ")[0]}` : ""}`) };
}

async function handleStudyConsent(contact, session, body) {
  const answer = String(body || "").trim().toLowerCase();
  const respondent = await store.findOne("respondents", { id: session.respondent_id });
  if (!respondent) return { message: "We couldn't find your study enrolment. Please reopen your invitation." };

  // Older in-progress sessions may still point at this retired step. Browser
  // consent is authoritative; do not ask for it a second time in WhatsApp.
  if (await currentConsent(respondent)) {
    const next = await saveSession(contact, { step: "ready" });
    return { message: await whatsappDiary.readyMessage(next, body, (patch) => saveSession(contact, patch)) };
  }

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
    message: `Thank you. You're enrolled in ${study ? study.name : "the study"} and WhatsApp is your preferred channel. Reply DIARY to start your first diary entry.`,
  };
}

router.post("/", async (req, res) => {
  if (!verifyTwilioSignature(req)) return res.status(403).send("Invalid Twilio signature");
  const contact = senderContact(req);
  if (!contact) return reply(res, "We couldn't read your WhatsApp number. Please contact the study team.");
  // A tapped List Picker row arrives as ButtonPayload (the row's id, "opt_N"
  // -- see lib/whatsappDiary.js's listPickerOptions), not Body. Translating
  // it to the same digit a typed reply would send lets the existing
  // parseAnswer()/optionFor() matching handle it with no further changes.
  const buttonPayload = String(req.body.ButtonPayload || "").trim();
  const tappedOption = /^opt_(\d+)$/.exec(buttonPayload);
  const body = tappedOption ? tappedOption[1] : String(req.body.Body || "").trim();
  const messageSid = String(req.body.MessageSid || "").trim();
  const remembered = await rememberedInbound(messageSid);
  if (remembered && remembered.reply) return reply(res, remembered.reply);
  const existingSession = await sessionFor(contact);
  if (messageSid && existingSession && existingSession.last_message_sid === messageSid && existingSession.last_reply) {
    return reply(res, existingSession.last_reply);
  }

  const flowSubmission = whatsappFlow.submissionFrom(req.body);
  if (flowSubmission) {
    const message = await whatsappFlow.handleSubmission({
      contact,
      body: req.body,
      session: existingSession,
      saveSession: (patch) => saveSession(contact, patch),
    });
    const submittedSession = await sessionFor(contact);
    if (submittedSession && messageSid) {
      await saveSession(contact, { last_message_sid: messageSid, last_reply: message });
    }
    await rememberInbound(messageSid, contact, submittedSession && submittedSession.respondent_id, message);
    return reply(res, message);
  }

  const join = /^JOIN\s+(.+)$/i.exec(body);
  if (join) {
    const token = String(join[1] || "").trim().replace(/^.*\/invite\//, "").split(/[?#]/)[0];
    const result = await startInvite(contact, token);
    const joinedSession = await sessionFor(contact);
    if (joinedSession && messageSid) await saveSession(contact, { last_message_sid: messageSid, last_reply: result.message });
    await rememberInbound(messageSid, contact, joinedSession && joinedSession.respondent_id, result.message);
    return reply(res, result.message);
  }

  const session = existingSession;
  if (!session) {
    const message = "To begin, open your INICIO invitation and choose WhatsApp. It will start this chat with your study invitation automatically.";
    await rememberInbound(messageSid, contact, null, message);
    return reply(res, message);
  }

  const saveCurrentSession = (patch) => saveSession(contact, patch);

  let result;
  if (session.step === "profile") result = await handleProfile(contact, session, body);
  else if (session.step === "study_consent") result = await handleStudyConsent(contact, session, body);
  else if (session.step === "ready" && whatsappFlow.isStartCommand(body)) {
    const launched = await whatsappFlow.launch({
      session,
      contact,
      saveSession: saveCurrentSession,
      source: "chat",
    });
    if (launched.launched) {
      result = {
        message: "Your diary form is open in the WhatsApp message above.",
        flowLaunched: true,
      };
    } else if (launched.message) {
      result = diaryOutcome(launched.message);
    } else {
      result = diaryOutcome(await whatsappDiary.readyMessage(session, body, saveCurrentSession));
    }
  }
  else if (session.step === "ready") result = diaryOutcome(await whatsappDiary.readyMessage(session, body, saveCurrentSession));
  else if (session.step === "diary") result = diaryOutcome(await whatsappDiary.handleDiaryAnswer(session, body, saveCurrentSession, inboundMedia(req)));
  else if (session.step === "paused_diary") result = diaryOutcome(await whatsappDiary.pausedMessage(session, body, saveCurrentSession));
  else if (session.step === "closeout") result = diaryOutcome(await whatsappDiary.handleCloseoutAnswer(session, body, saveCurrentSession));
  else if (session.step === "paused_closeout") result = diaryOutcome(await whatsappDiary.pausedCloseoutMessage(session, body, saveCurrentSession));
  else if (session.step === "stop_confirm") result = diaryOutcome(await whatsappDiary.stopConfirmationMessage(session, body, saveCurrentSession));
  else if (session.step === "closeout_done") result = { message: "Your final study check is complete and your diary is closed. Thank you for taking part." };
  else if (session.step === "withdrawn") result = { message: "You have withdrawn from this study. Contact the study team if you need help with your data or believe this was a mistake." };
  else if (session.step === "needs_browser") result = { message: "Please reopen your INICIO invitation and complete the required browser step before continuing in WhatsApp." };
  else if (session.step === "declined") result = { message: "You previously declined this study. Contact the study team if you want to change that choice." };
  else result = { message: "Please reopen your INICIO invitation and choose WhatsApp again." };

  if (messageSid) await saveSession(contact, { last_message_sid: messageSid, last_reply: result.message });
  const updatedSession = await sessionFor(contact);
  await rememberInbound(messageSid, contact, updatedSession && updatedSession.respondent_id, result.message);

  if (result.flowLaunched) {
    return res.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  if (result.listPicker) {
    const { question, options } = result.listPicker;
    const contentSid = messaging.listPickerContentSid(options.length);
    if (contentSid) {
      const sent = await messaging.sendWhatsAppListPicker({
        respondentId: session.respondent_id,
        to: contact,
        contentSid,
        variables: listPickerVariables(question, options),
        logBody: result.message,
      }).catch(() => null);
      // A List Picker is only ever sent inside a session the respondent
      // already opened, so it can't fail on Meta's approval/window rule the
      // way the cold OTP send could -- but if it fails for any other reason
      // (misconfigured sender, transient Twilio error), fall through to the
      // ordinary text reply below rather than leaving the respondent stuck.
      if (sent && sent.ok) return res.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
  }
  reply(res, result.message);
});

module.exports = router;

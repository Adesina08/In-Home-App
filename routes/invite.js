// Cold-invite respondent onboarding for Inicio Diary.
//
// Target sequence:
// invite link / QR -> configurable pre-survey -> choose participation channel
// -> create reusable username/password (or reuse an existing Inicio Diary
// account) -> app download or WhatsApp handoff.
const express = require("express");
const store = require("../lib/store");
const accounts = require("../lib/respondentAccounts");
const { loadQuestionnaire } = require("../lib/questionnaire");
const { logAudit } = require("../lib/audit");
const { splitPresurvey } = require("../lib/presurveySections");
const otp = require("../lib/otp");
const messaging = require("../lib/whatsapp");
const { isBypassed: respondentOtpBypassed } = require("../lib/respondentOtpMode");
const { isEmail: contactIsEmail } = require("../lib/contact");

const router = express.Router();

function apkUrl() {
  return (process.env.ANDROID_APK_URL || "").trim() || "/public/downloads/inicio-diary.apk";
}

function whatsappReady() {
  return (process.env.WHATSAPP_BOT_NUMBER || "").trim() || null;
}

function whatsappChatUrl(inviteToken) {
  const configured = whatsappReady();
  if (!configured) return null;
  const digits = configured.replace(/^whatsapp:/i, "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(`JOIN ${inviteToken}`)}`;
}

const CADENCE = {
  realtime: "each time you consume something, as it happens",
  daily: "once a day",
  weekly: "once a week",
  monthly: "once a month",
};

async function presurveyQuestions(studyId) {
  const { questions } = await loadQuestionnaire(studyId);
  return splitPresurvey(questions).presurvey;
}

function isEmptyAnswer(value) {
  if (Array.isArray(value)) return value.length === 0;
  return value === undefined || value === null || String(value).trim() === "";
}

/** Display-only, never stored: "jo***@example.com" or "+234******5678". */
function maskContact(contact) {
  const raw = String(contact || "");
  if (!raw) return "";
  if (contactIsEmail(raw)) {
    const [user, domain] = raw.split("@");
    const visible = user.slice(0, Math.min(2, user.length));
    return `${visible}${"*".repeat(Math.max(user.length - visible.length, 3))}@${domain}`;
  }
  // Contacts are stored canonically (lib/contact.js), so a non-email contact
  // here is always "+<countrycode><digits>" -- mask everything but the last 4.
  if (raw.length <= 4) return "*".repeat(Math.max(raw.length, 3));
  return `${raw.slice(0, -4).replace(/\d/g, "*")}${raw.slice(-4)}`;
}

async function loadInvite(req, res) {
  const respondent = await store.findOne("respondents", { unique_token: req.params.token });
  if (!respondent) {
    res.status(404).render("error", { message: "This invitation link is not valid. Please check the link in your message.", user: null });
    return null;
  }
  const study = await store.findOne("studies", { id: respondent.study_id });
  if (!study) {
    res.status(404).render("error", { message: "This study is no longer available.", user: null });
    return null;
  }
  return { respondent, study };
}

async function continueAfterAccount(res, respondent) {
  if (respondent.chosen_mode === "whatsapp") {
    const wa = whatsappChatUrl(respondent.unique_token);
    if (wa) return res.redirect(wa);
    return res.status(503).render("error", {
      message: "WhatsApp participation is not configured for this deployment yet. Please return to your invitation and choose the INICIO Diary mobile app.",
      user: null,
    });
  }
  const downloadUrl = apkUrl();
  const separator = downloadUrl.includes("?") ? "&" : "?";
  return res.redirect(`${downloadUrl}${separator}invite=${encodeURIComponent(respondent.unique_token)}`);
}

router.get("/:token/presurvey", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;
  const questions = await presurveyQuestions(study.id);
  res.render("invite/presurvey", {
    respondent,
    study,
    questions,
    values: {
      name: respondent.name || "",
      contact: respondent.contact || "",
      answers: respondent.presurvey_answers || {},
    },
    error: null,
    user: null,
  });
});

router.post("/:token/presurvey", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;
  const questions = await presurveyQuestions(study.id);
  const name = String(req.body.name || "").trim();
  const contact = String(req.body.contact || "").trim();
  const answers = {};

  for (const q of questions) {
    let value = req.body[`pq_${q.id}`];
    if (q.type === "multi" && value !== undefined && !Array.isArray(value)) value = [value];
    if (q.type === "numeric" && !isEmptyAnswer(value)) {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        return res.status(400).render("invite/presurvey", {
          respondent, study, questions,
          values: { name, contact, answers: { ...answers, [q.id]: value } },
          error: `Please enter a valid number for “${q.text}”.`, user: null,
        });
      }
      value = number;
    }
    answers[q.id] = value;
  }

  const renderFail = (error) => res.status(400).render("invite/presurvey", {
    respondent,
    study,
    questions,
    values: { name, contact, answers },
    error,
    user: null,
  });

  if (!name || !contact) return renderFail("Please complete your name and phone number or email before continuing.");
  const missing = questions.find((q) => q.required && isEmptyAnswer(answers[q.id]));
  if (missing) return renderFail(`Please answer “${missing.text}” before continuing.`);

  await store.update("respondents", { id: respondent.id }, {
    name,
    contact,
    presurvey_answers: answers,
    presurvey_completed_at: store.nowSql(),
  });
  logAudit(`respondent:${respondent.respondent_code}`, "invite_presurvey_completed", "respondents", respondent.id, {
    configured_question_count: questions.length,
  });
  return res.redirect(`/invite/${respondent.unique_token}`);
});

router.get("/:token/account", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;
  if (!respondent.presurvey_completed_at) return res.redirect(`/invite/${respondent.unique_token}/presurvey`);
  if (!respondent.chosen_mode) return res.redirect(`/invite/${respondent.unique_token}`);

  const existing = respondent.account_id ? await accounts.getById(respondent.account_id) : null;
  res.render("invite/account", {
    respondent,
    study,
    username: existing && existing.username ? existing.username : "",
    existingAccount: !!(existing && existing.password_hash),
    error: null,
    user: null,
  });
});

router.post("/:token/account", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;
  if (!respondent.presurvey_completed_at) return res.redirect(`/invite/${respondent.unique_token}/presurvey`);
  if (!respondent.chosen_mode) return res.redirect(`/invite/${respondent.unique_token}`);

  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirm_password || "");
  const currentAccount = respondent.account_id ? await accounts.getById(respondent.account_id) : null;
  const fail = (error) => res.status(400).render("invite/account", {
    respondent,
    study,
    username,
    existingAccount: !!(currentAccount && currentAccount.password_hash),
    error,
    user: null,
  });

  try {
    const account = currentAccount || await accounts.findOrCreate({ contact: respondent.contact, name: respondent.name });
    if (!account) return fail("We couldn't create your INICIO Diary account. Please try again.");

    // A returning respondent keeps the credentials they already use on their
    // other studies. Never allow a new study invitation to reset that password.
    if (!account.password_hash) {
      if (password !== confirmPassword) return fail("The passwords do not match.");
      await accounts.setCredentials(account.id, { username, password });
    }

    await store.update("respondents", { id: respondent.id }, {
      account_id: account.id,
      account_created_at: respondent.account_created_at || store.nowSql(),
    });
    logAudit(`respondent:${respondent.respondent_code}`, account.password_hash ? "inicio_diary_account_reused" : "inicio_diary_account_created", "respondent_accounts", account.id, {
      study_id: study.id,
      channel: respondent.chosen_mode,
    });
  } catch (e) {
    return fail(e.message || "We couldn't create your INICIO Diary account. Please try again.");
  }

  return continueAfterAccount(res, respondent);
});

// A returning respondent whose account already has a password never sees the
// create-password fields on /account (their existing credentials carry over
// to every study). This is the escape hatch for someone who genuinely forgot
// that password: verify they still own the contact on file, then let them set
// a new one. Session-scoped to this invite token so completing it never grants
// access beyond what the invite link itself already implies.
async function loadResetAccount(req, res) {
  const loaded = await loadInvite(req, res);
  if (!loaded) return null;
  const { respondent, study } = loaded;
  const account = respondent.account_id ? await accounts.getById(respondent.account_id) : null;
  if (!account || !account.password_hash) {
    res.redirect(`/invite/${respondent.unique_token}/account`);
    return null;
  }
  return { respondent, study, account };
}

router.get("/:token/reset-password", async (req, res) => {
  const loaded = await loadResetAccount(req, res);
  if (!loaded) return;
  const { respondent, study, account } = loaded;
  res.render("invite/reset_password", {
    respondent, study, step: "request",
    maskedContact: maskContact(account.contact),
    error: null, notice: null, user: null,
  });
});

router.post("/:token/reset-password", async (req, res) => {
  const loaded = await loadResetAccount(req, res);
  if (!loaded) return;
  const { respondent, study, account } = loaded;
  const render = (error) => res.status(400).render("invite/reset_password", {
    respondent, study, step: "request",
    maskedContact: maskContact(account.contact),
    error, notice: null, user: null,
  });

  if (!respondentOtpBypassed()) {
    try {
      await otp.sendCode({
        contact: account.contact,
        respondentId: respondent.id,
        purpose: "account_password_reset",
        studyName: study.name,
      });
    } catch (e) {
      if (e.code !== "COOLDOWN") return render(e.message || "We couldn't send a code just now. Please try again in a moment.");
    }
  }
  req.session.pwResetToken = respondent.unique_token;
  return res.redirect(`/invite/${respondent.unique_token}/reset-password/verify`);
});

router.get("/:token/reset-password/verify", async (req, res) => {
  const loaded = await loadResetAccount(req, res);
  if (!loaded) return;
  const { respondent, study, account } = loaded;
  if (respondentOtpBypassed()) return res.redirect(`/invite/${respondent.unique_token}/reset-password/new`);
  if (req.session.pwResetToken !== respondent.unique_token) return res.redirect(`/invite/${respondent.unique_token}/reset-password`);
  res.render("invite/reset_password", {
    respondent, study, step: "verify",
    maskedContact: maskContact(account.contact),
    simulated: !messaging.isRealMessagingConfigured(),
    ttlMinutes: otp.TTL_MINUTES,
    error: null, notice: null, user: null,
  });
});

router.post("/:token/reset-password/verify", async (req, res) => {
  const loaded = await loadResetAccount(req, res);
  if (!loaded) return;
  const { respondent, study, account } = loaded;
  if (respondentOtpBypassed()) return res.redirect(`/invite/${respondent.unique_token}/reset-password/new`);
  const render = (error) => res.status(400).render("invite/reset_password", {
    respondent, study, step: "verify",
    maskedContact: maskContact(account.contact),
    simulated: !messaging.isRealMessagingConfigured(),
    ttlMinutes: otp.TTL_MINUTES,
    error, notice: null, user: null,
  });
  if (req.session.pwResetToken !== respondent.unique_token) return res.redirect(`/invite/${respondent.unique_token}/reset-password`);

  const result = await otp.verifyCode({ contact: account.contact, code: req.body.code, purpose: "account_password_reset" });
  if (!result.ok) return render(result.reason);

  delete req.session.pwResetToken;
  req.session.pwResetVerifiedToken = respondent.unique_token;
  logAudit(`respondent:${respondent.respondent_code}`, "account_password_reset_verified", "respondent_accounts", account.id, {});
  return res.redirect(`/invite/${respondent.unique_token}/reset-password/new`);
});

router.post("/:token/reset-password/resend", async (req, res) => {
  const loaded = await loadResetAccount(req, res);
  if (!loaded) return;
  const { respondent, study, account } = loaded;
  if (req.session.pwResetToken === respondent.unique_token && !respondentOtpBypassed()) {
    try {
      await otp.sendCode({
        contact: account.contact,
        respondentId: respondent.id,
        purpose: "account_password_reset",
        studyName: study.name,
      });
    } catch (e) {
      return res.status(e.code === "COOLDOWN" ? 429 : 502).render("invite/reset_password", {
        respondent, study, step: "verify",
        maskedContact: maskContact(account.contact),
        simulated: !messaging.isRealMessagingConfigured(),
        ttlMinutes: otp.TTL_MINUTES,
        error: e.message, notice: null, user: null,
      });
    }
  }
  return res.redirect(`/invite/${respondent.unique_token}/reset-password/verify?resent=1`);
});

router.get("/:token/reset-password/new", async (req, res) => {
  const loaded = await loadResetAccount(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;
  if (!respondentOtpBypassed() && req.session.pwResetVerifiedToken !== respondent.unique_token) {
    return res.redirect(`/invite/${respondent.unique_token}/reset-password`);
  }
  res.render("invite/reset_password", {
    respondent, study, step: "new",
    error: null, notice: null, user: null,
  });
});

router.post("/:token/reset-password/new", async (req, res) => {
  const loaded = await loadResetAccount(req, res);
  if (!loaded) return;
  const { respondent, study, account } = loaded;
  if (!respondentOtpBypassed() && req.session.pwResetVerifiedToken !== respondent.unique_token) {
    return res.redirect(`/invite/${respondent.unique_token}/reset-password`);
  }
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirm_password || "");
  const render = (error) => res.status(400).render("invite/reset_password", {
    respondent, study, step: "new", error, notice: null, user: null,
  });
  if (password !== confirmPassword) return render("The passwords do not match.");

  try {
    await accounts.resetPassword(account.id, password);
  } catch (e) {
    return render(e.message || "We couldn't reset your password. Please try again.");
  }
  delete req.session.pwResetVerifiedToken;
  logAudit(`respondent:${respondent.respondent_code}`, "account_password_reset_completed", "respondent_accounts", account.id, {});
  return res.redirect(`/invite/${respondent.unique_token}/account`);
});

router.get("/:token", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;

  if (respondent.activation_status === "disqualified") {
    return res.render("invite/welcome", {
      respondent,
      study,
      cadence: CADENCE[study.diary_mode] || "from time to time",
      apkUrl: apkUrl(),
      whatsappNumber: whatsappReady(),
      declined: true,
      user: null,
    });
  }

  if (!respondent.presurvey_completed_at) {
    return res.redirect(`/invite/${respondent.unique_token}/presurvey`);
  }

  // Even an existing Inicio Diary user chooses how they want to participate
  // in this study before we reuse their account.
  if (!respondent.chosen_mode) {
    return res.render("invite/welcome", {
      respondent,
      study,
      cadence: CADENCE[study.diary_mode] || "from time to time",
      apkUrl: apkUrl(),
      whatsappNumber: whatsappReady(),
      declined: false,
      user: null,
    });
  }

  if (respondent.account_id) {
    const account = await accounts.getById(respondent.account_id);
    if (account && account.password_hash) {
      if (respondent.chosen_mode === "whatsapp") {
        const wa = whatsappChatUrl(respondent.unique_token);
        if (wa) return res.redirect(wa);
      }
      return res.redirect("/mobile/login?ready=1");
    }
  }

  return res.redirect(`/invite/${respondent.unique_token}/account`);
});

router.post("/:token/choose", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent } = loaded;
  if (!respondent.presurvey_completed_at) return res.redirect(`/invite/${respondent.unique_token}/presurvey`);

  const requested = ["app", "apk", "whatsapp"].includes(req.body.mode) ? req.body.mode : "app";
  const mode = requested === "apk" ? "app" : requested;
  const preferredChannel = mode === "whatsapp" ? "whatsapp" : "app";

  await store.update("respondents", { id: respondent.id }, {
    chosen_mode: mode,
    preferred_channel: preferredChannel,
  });
  logAudit(`respondent:${respondent.respondent_code}`, "invite_mode_chosen", "respondents", respondent.id, { mode });
  return res.redirect(`/invite/${respondent.unique_token}/account`);
});

router.post("/:token/decline", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent } = loaded;
  await store.update("respondents", { id: respondent.id }, {
    activation_status: "disqualified",
    disqualify_reason: "Declined the invitation",
    disqualified_at: store.nowSql(),
  });
  logAudit(`respondent:${respondent.respondent_code}`, "invite_declined", "respondents", respondent.id, {});
  res.render("invite/declined", { study: loaded.study, user: null });
});

module.exports = router;

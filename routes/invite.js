// Cold-invite respondent onboarding for Inicio Diary.
//
// Target sequence:
// invite link / QR -> configurable pre-survey -> choose participation channel
// -> create reusable username/password -> app download or WhatsApp handoff.
const express = require("express");
const store = require("../lib/store");
const accounts = require("../lib/respondentAccounts");
const { loadQuestionnaire } = require("../lib/questionnaire");
const { logAudit } = require("../lib/audit");

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

function isPresurveySection(section) {
  return ["presurvey", "pre-survey", "pre survey", "screening", "screener"].includes(String(section || "").trim().toLowerCase());
}

async function presurveyQuestions(studyId) {
  const { questions } = await loadQuestionnaire(studyId);
  return questions.filter((q) => isPresurveySection(q.section));
}

function isEmptyAnswer(value) {
  if (Array.isArray(value)) return value.length === 0;
  return value === undefined || value === null || String(value).trim() === "";
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
  const fail = (error) => res.status(400).render("invite/account", { respondent, study, username, error, user: null });
  if (password !== confirmPassword) return fail("The passwords do not match.");

  try {
    const account = respondent.account_id
      ? await accounts.getById(respondent.account_id)
      : await accounts.findOrCreate({ contact: respondent.contact, name: respondent.name });
    if (!account) return fail("We couldn't create your Inicio Diary account. Please try again.");
    await accounts.setCredentials(account.id, { username, password });
    await store.update("respondents", { id: respondent.id }, {
      account_id: account.id,
      account_created_at: store.nowSql(),
    });
    logAudit(`respondent:${respondent.respondent_code}`, "inicio_diary_account_created", "respondent_accounts", account.id, {
      study_id: study.id,
      channel: respondent.chosen_mode,
    });
  } catch (e) {
    return fail(e.message || "We couldn't create your Inicio Diary account. Please try again.");
  }

  if (respondent.chosen_mode === "whatsapp") {
    const wa = whatsappChatUrl(respondent.unique_token);
    if (wa) return res.redirect(wa);
    return res.status(503).render("error", {
      message: "WhatsApp participation is not configured for this deployment yet. Please return to your invitation and choose the Inicio Diary mobile app.",
      user: null,
    });
  }

  const downloadUrl = apkUrl();
  const separator = downloadUrl.includes("?") ? "&" : "?";
  return res.redirect(`${downloadUrl}${separator}invite=${encodeURIComponent(respondent.unique_token)}`);
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

  res.render("invite/welcome", {
    respondent,
    study,
    cadence: CADENCE[study.diary_mode] || "from time to time",
    apkUrl: apkUrl(),
    whatsappNumber: whatsappReady(),
    declined: false,
    user: null,
  });
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

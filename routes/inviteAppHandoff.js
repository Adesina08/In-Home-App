// Keeps the browser invitation/setup journey separate from the installed
// Inicio Diary login experience.
//
// New respondent: /invite/:token -> presurvey -> channel -> account -> ready
// Returning respondent: /invite/:token -> choose app or WhatsApp again
// Installed Android app: /mobile/login -> diary
const express = require("express");
const store = require("../lib/store");
const accounts = require("../lib/respondentAccounts");
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

async function loadInvite(req, res) {
  const respondent = await store.findOne("respondents", { unique_token: req.params.token });
  if (!respondent) {
    res.status(404).render("error", {
      message: "This invitation link is not valid. Please check the link in your message.",
      user: null,
    });
    return null;
  }
  const study = await store.findOne("studies", { id: respondent.study_id });
  if (!study) {
    res.status(404).render("error", { message: "This study is no longer available.", user: null });
    return null;
  }
  return { respondent, study };
}

async function readyAccount(respondent) {
  if (!respondent || !respondent.account_id) return null;
  const account = await accounts.getById(respondent.account_id);
  return account && account.password_hash ? account : null;
}

function renderReady(res, respondent, study, account) {
  return res.render("invite/account", {
    respondent,
    study,
    username: account.username || "",
    existingAccount: true,
    ready: true,
    apkUrl: apkUrl(),
    error: null,
    user: null,
  });
}

function renderReturningChoice(res, respondent, study) {
  return res.render("invite/welcome", {
    respondent,
    study,
    cadence: CADENCE[study.diary_mode] || "from time to time",
    apkUrl: apkUrl(),
    whatsappNumber: whatsappReady(),
    declined: false,
    returningAccount: true,
    user: null,
  });
}

// Re-scanning a completed invitation must not lock the respondent into the
// channel they chose previously. Show the channel choice again so someone who
// used WhatsApp can later download the app, and an app user can move back to
// WhatsApp without needing a new invitation.
router.get("/:token", async (req, res, next) => {
  const respondent = await store.findOne("respondents", { unique_token: req.params.token });
  if (!respondent) return next();
  if (!respondent.presurvey_completed_at || respondent.activation_status === "disqualified") return next();

  const account = await readyAccount(respondent);
  if (!account) return next();

  const study = await store.findOne("studies", { id: respondent.study_id });
  if (!study) return next();

  return renderReturningChoice(res, respondent, study);
});

// Returning respondents already have credentials, so their channel choice can
// complete immediately: app -> ready/download handoff, WhatsApp -> chat.
// First-time respondents fall through to routes/invite.js, which sends them to
// account creation before either handoff.
router.post("/:token/choose", async (req, res, next) => {
  const respondent = await store.findOne("respondents", { unique_token: req.params.token });
  if (!respondent || !respondent.presurvey_completed_at || respondent.activation_status === "disqualified") {
    return next();
  }

  const account = await readyAccount(respondent);
  if (!account) return next();

  const requested = ["app", "apk", "whatsapp"].includes(req.body.mode) ? req.body.mode : "app";
  const mode = requested === "apk" ? "app" : requested;
  const preferredChannel = mode === "whatsapp" ? "whatsapp" : "app";

  await store.update("respondents", { id: respondent.id }, {
    chosen_mode: mode,
    preferred_channel: preferredChannel,
  });
  logAudit(
    `respondent:${respondent.respondent_code}`,
    "invite_mode_chosen",
    "respondents",
    respondent.id,
    { mode, returning_account: true }
  );

  if (mode === "app") {
    return res.redirect(`/invite/${respondent.unique_token}/ready`);
  }

  const wa = whatsappChatUrl(respondent.unique_token);
  if (wa) return res.redirect(wa);

  return res.status(503).render("error", {
    message: "WhatsApp participation is not configured for this deployment yet. Please choose the INICIO Diary mobile app instead.",
    user: null,
  });
});

router.get("/:token/ready", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;
  if (!respondent.presurvey_completed_at) {
    return res.redirect(`/invite/${respondent.unique_token}/presurvey`);
  }
  if (respondent.chosen_mode !== "app") {
    return res.redirect(`/invite/${respondent.unique_token}`);
  }
  const account = await readyAccount(respondent);
  if (!account) return res.redirect(`/invite/${respondent.unique_token}/account`);
  return renderReady(res, respondent, study, account);
});

// App participants finish account creation here so the browser lands on the
// ready/download handoff instead of immediately downloading or showing login.
router.post("/:token/account-app", async (req, res, next) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;
  if (respondent.chosen_mode !== "app") return next();
  if (!respondent.presurvey_completed_at) {
    return res.redirect(`/invite/${respondent.unique_token}/presurvey`);
  }

  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirm_password || "");
  const currentAccount = respondent.account_id ? await accounts.getById(respondent.account_id) : null;

  const fail = (error, existingAccount = !!(currentAccount && currentAccount.password_hash)) =>
    res.status(400).render("invite/account", {
      respondent,
      study,
      username: currentAccount && currentAccount.username ? currentAccount.username : username,
      existingAccount,
      ready: false,
      error,
      user: null,
    });

  try {
    const account = currentAccount || await accounts.findOrCreate({
      contact: respondent.contact,
      name: respondent.name,
    });
    if (!account) return fail("We couldn't create your INICIO Diary account. Please try again.", false);

    const hadPassword = !!account.password_hash;
    if (!hadPassword) {
      if (password !== confirmPassword) return fail("The passwords do not match.", false);
      await accounts.setCredentials(account.id, { username, password });
    }

    await store.update("respondents", { id: respondent.id }, {
      account_id: account.id,
      account_created_at: respondent.account_created_at || store.nowSql(),
    });

    logAudit(
      `respondent:${respondent.respondent_code}`,
      hadPassword ? "inicio_diary_account_reused" : "inicio_diary_account_created",
      "respondent_accounts",
      account.id,
      { study_id: study.id, channel: "app" }
    );

    return res.redirect(`/invite/${respondent.unique_token}/ready`);
  } catch (e) {
    return fail(e.message || "We couldn't create your INICIO Diary account. Please try again.");
  }
});

module.exports = router;

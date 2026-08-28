// Keeps the browser invitation/setup journey separate from the installed
// Inicio Diary login experience.
//
// New respondent: /invite/:token -> presurvey -> channel -> account -> ready
// Returning to the same invitation after setup: /invite/:token -> ready
// Installed Android app: /mobile/login -> diary
const express = require("express");
const store = require("../lib/store");
const accounts = require("../lib/respondentAccounts");
const { logAudit } = require("../lib/audit");

const router = express.Router();

function apkUrl() {
  return (process.env.ANDROID_APK_URL || "").trim() || "/public/downloads/inicio-diary.apk";
}

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

// A completed app invitation must never fall through to /mobile/login in the
// browser. Re-opening the invite/QR shows the app handoff screen instead.
router.get("/:token", async (req, res, next) => {
  const respondent = await store.findOne("respondents", { unique_token: req.params.token });
  if (!respondent) return next();
  if (!respondent.presurvey_completed_at || respondent.chosen_mode !== "app") return next();
  const account = await readyAccount(respondent);
  if (!account) return next();
  const study = await store.findOne("studies", { id: respondent.study_id });
  if (!study) return next();
  return renderReady(res, respondent, study, account);
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
    if (!account) return fail("We couldn't create your Inicio Diary account. Please try again.", false);

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
    return fail(e.message || "We couldn't create your Inicio Diary account. Please try again.");
  }
});

module.exports = router;

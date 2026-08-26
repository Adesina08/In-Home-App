// The page a cold-invited respondent lands on.
//
// Someone who received an unsolicited text needs three things before being
// asked for anything: what the study is, what taking part actually involves,
// and a way to decline that doesn't require doing anything. Opening straight
// onto a consent form -- which is what the diary link does -- asks for a
// commitment from a person who has not yet been told what they're committing
// to, and reads like a scam.
//
// So: brief, cadence, then a choice of how to take part. Only after that do
// they reach consent and the diary.

const express = require("express");
const db = require("../lib/db");
const { logAudit } = require("../lib/audit");

const router = express.Router();

// The Android build is produced and signed outside this app (see mobile/
// README) and hosted wherever you put it. Unset means no APK exists yet, and
// the option is HIDDEN rather than shown broken -- offering a download that
// 404s is worse than not offering it.
function apkUrl() {
  return (process.env.ANDROID_APK_URL || "").trim() || null;
}

// The WhatsApp survey bot is a separate build (an approved WhatsApp Business
// sender, a webhook, and the questionnaire rendered as message turns). Until
// that exists the option is shown but disabled, because respondents choosing
// between two things should be able to see what the second one is.
function whatsappReady() {
  return (process.env.WHATSAPP_BOT_NUMBER || "").trim() ? (process.env.WHATSAPP_BOT_NUMBER || "").trim() : null;
}

const CADENCE = {
  realtime: "each time you consume something, as it happens",
  daily: "once a day",
  weekly: "once a week",
  monthly: "once a month",
};

function loadInvite(req, res) {
  const respondent = db.prepare("SELECT * FROM respondents WHERE unique_token = ?").get(req.params.token);
  if (!respondent) {
    res.status(404).render("error", { message: "This invitation link is not valid. Please check the link in your message.", user: null });
    return null;
  }
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(respondent.study_id);
  return { respondent, study };
}

router.get("/:token", (req, res) => {
  const loaded = loadInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;

  // Someone who already agreed and started shouldn't be asked to choose again
  // -- send them to their diary.
  if (respondent.consent_status === "given" && respondent.chosen_mode) {
    return res.redirect(`/r/${respondent.unique_token}`);
  }

  res.render("invite/welcome", {
    respondent,
    study,
    cadence: CADENCE[study.diary_mode] || "from time to time",
    apkUrl: apkUrl(),
    whatsappNumber: whatsappReady(),
    declined: respondent.activation_status === "disqualified",
    user: null,
  });
});

// Recording the choice is what makes recruitment reportable -- otherwise
// "which mode do people prefer" is unanswerable, and that's one of the things
// a pilot exists to find out.
router.post("/:token/choose", (req, res) => {
  const loaded = loadInvite(req, res);
  if (!loaded) return;
  const { respondent } = loaded;
  const mode = ["app", "apk", "whatsapp"].includes(req.body.mode) ? req.body.mode : "app";

  db.prepare("UPDATE respondents SET chosen_mode = ? WHERE id = ?").run(mode, respondent.id);
  logAudit(`respondent:${respondent.respondent_code}`, "invite_mode_chosen", "respondents", respondent.id, { mode });

  if (mode === "apk" && apkUrl()) {
    return res.render("invite/apk", { respondent, apkUrl: apkUrl(), user: null });
  }
  // WhatsApp isn't built yet; anyone who reaches here with that choice falls
  // through to the web app rather than being stranded.
  res.redirect(`/r/${respondent.unique_token}`);
});

// Declining has to be one tap and must not require signing in. A respondent
// with no way to say no simply stops answering, which is indistinguishable
// from a broken link and leaves the study chasing them with reminders.
router.post("/:token/decline", (req, res) => {
  const loaded = loadInvite(req, res);
  if (!loaded) return;
  const { respondent } = loaded;
  db.prepare(
    "UPDATE respondents SET activation_status = 'disqualified', disqualify_reason = 'Declined the invitation', disqualified_at = datetime('now') WHERE id = ?"
  ).run(respondent.id);
  logAudit(`respondent:${respondent.respondent_code}`, "invite_declined", "respondents", respondent.id, {});
  res.render("invite/declined", { study: loaded.study, user: null });
});

module.exports = router;

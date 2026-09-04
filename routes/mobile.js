const express = require("express");
const store = require("../lib/store");
const accounts = require("../lib/respondentAccounts");
const { logAudit } = require("../lib/audit");

const router = express.Router();

// Native Expo API. Keeping it under /mobile/api means the public mobile router
// remains the single mount point in server.js while the web login and native
// client share the same respondent-account rules.
router.use("/api", require("./mobileNativeAuth"));
router.use("/api", require("./mobileApi"));

router.get("/login", async (req, res) => {
  // Already signed in: straight back into the diary.
  if (req.session.respondentAccountId) {
    const target = await singleDiaryTarget(req.session.respondentAccountId);
    if (target) return res.redirect(target);
  }
  res.render("mobile/login", {
    error: null,
    username: "",
    ready: req.query.ready === "1",
    user: null,
  });
});

router.post("/login", async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const account = await accounts.verifyCredentials(username, password);
  if (!account) {
    return res.status(401).render("mobile/login", {
      error: "That username or password is not correct.",
      username,
      ready: false,
      user: null,
    });
  }

  req.session.respondentAccountId = account.id;
  await accounts.markVerified(account.id);
  logAudit(`account:${account.username || account.id}`, "inicio_diary_login", "respondent_accounts", account.id, {});

  const enrolments = await accounts.enrolmentsFor(account.id);
  if (!enrolments.length) {
    req.session.respondentAccountId = null;
    return res.status(403).render("mobile/login", {
      error: "Your account is not linked to an active diary yet. Please use your invitation link first.",
      username,
      ready: false,
      user: null,
    });
  }

  // Into the diary, not via a studies list. The app exists to log an occasion;
  // an interstitial listing one study is a tap that teaches nothing.
  //
  // The list is still used when there is a genuine choice to make -- with two
  // enrolments the app must not pick for them.
  const target = await singleDiaryTarget(account.id);
  return res.redirect(target || "/me");
});

router.post("/logout", (req, res) => {
  req.session.respondentAccountId = null;
  res.redirect("/mobile/login");
});

/**
 * The diary URL to open on sign-in, or null when the person is on more than one
 * study and should choose.
 */
async function singleDiaryTarget(accountId) {
  const enrolments = await accounts.enrolmentsFor(accountId);
  const open = enrolments.filter((r) => ["activated", "active", "screened"].includes(r.activation_status));
  const usable = open.length ? open : enrolments;
  if (usable.length !== 1 || !usable[0].unique_token) return null;

  // `?app=1` marks the session as running inside the native shell, which is
  // what lets the device-lock gate skip a check that cannot succeed there.
  return `/r/${usable[0].unique_token}?app=1`;
}

module.exports = router;

const express = require("express");
const store = require("../lib/store");
const accounts = require("../lib/respondentAccounts");
const { logAudit } = require("../lib/audit");

const router = express.Router();

router.get("/login", async (req, res) => {
  // Already signed in: go to the studies list, not straight into a diary.
  if (req.session.respondentAccountId) return res.redirect("/me");
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

  // Land on the studies list rather than jumping into whichever diary happened
  // to sort first. Dropping someone straight into a study is wrong even with
  // one enrolment -- they have no idea which diary they are in, and on a second
  // study the app would silently pick for them.
  return res.redirect("/me");
});

router.post("/logout", (req, res) => {
  req.session.respondentAccountId = null;
  res.redirect("/mobile/login");
});

module.exports = router;

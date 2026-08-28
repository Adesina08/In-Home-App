const express = require("express");
const store = require("../lib/store");
const accounts = require("../lib/respondentAccounts");
const { logAudit } = require("../lib/audit");

const router = express.Router();

router.get("/login", async (req, res) => {
  if (req.session.respondentAccountId) {
    const enrolments = await accounts.enrolmentsFor(req.session.respondentAccountId);
    const target = enrolments.find((r) => ["activated", "active", "screened"].includes(r.activation_status)) || enrolments[0];
    if (target && target.unique_token) return res.redirect(`/r/${target.unique_token}`);
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
  const target = enrolments.find((r) => ["activated", "active", "screened"].includes(r.activation_status)) || enrolments[0];
  if (!target || !target.unique_token) {
    req.session.respondentAccountId = null;
    return res.status(403).render("mobile/login", {
      error: "Your account is not linked to an active diary yet. Please use your invitation link first.",
      username,
      ready: false,
      user: null,
    });
  }
  return res.redirect(`/r/${target.unique_token}`);
});

router.post("/logout", (req, res) => {
  req.session.respondentAccountId = null;
  res.redirect("/mobile/login");
});

module.exports = router;

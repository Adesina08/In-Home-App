const express = require("express");
const accounts = require("../lib/respondentAccounts");
const mobileAuth = require("../lib/mobileAuth");
const { logAudit } = require("../lib/audit");

const router = express.Router();

function publicAccount(account) {
  return account ? { id: account.id, name: account.name || null, contact: account.contact, username: account.username || null } : null;
}

router.post("/auth/login", async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!username || !password) return res.status(400).json({ error: "Enter your username and password." });

  const account = await accounts.verifyCredentials(username, password);
  if (!account) return res.status(401).json({ error: "That username or password is not correct." });

  const enrolments = await accounts.enrolmentsFor(account.id);
  if (!enrolments.length) return res.status(403).json({ error: "Your account is not linked to an active diary yet. Please use your invitation link first." });

  await accounts.markVerified(account.id);
  const session = await mobileAuth.issueSession({ accountId: account.id });
  logAudit(`account:${account.username || account.id}`, "inicio_native_login", "respondent_accounts", account.id, {});
  res.json({ token: session.token, expiresAt: session.expiresAt, account: publicAccount(account) });
});

module.exports = router;

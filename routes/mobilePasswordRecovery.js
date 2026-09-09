const express = require("express");
const accounts = require("../lib/respondentAccounts");
const otp = require("../lib/otp");
const messaging = require("../lib/whatsapp");
const mobileAuth = require("../lib/mobileAuth");
const { logAudit } = require("../lib/audit");

const router = express.Router();

function publicAccount(account) {
  return account ? { id: account.id, name: account.name || null, contact: account.contact } : null;
}

function deliveryContact(account, suppliedContact) {
  // Password recovery must prove access to the contact that is stored on the
  // respondent account. The supplied value is only an account lookup hint.
  // Canonicalising the stored value also keeps legacy local-format phone
  // numbers deliverable through Twilio.
  return otp.normalizeContact(account ? account.contact : suppliedContact);
}

router.post("/auth/request-code", async (req, res) => {
  const suppliedContact = String(req.body.contact || "").trim();
  if (!suppliedContact) return res.status(400).json({ error: "Enter your phone number or email." });

  const account = await accounts.findByContact(suppliedContact);
  const target = deliveryContact(account, suppliedContact);
  const simulated = !messaging.isRealMessagingConfigured(target || suppliedContact);

  if (account) {
    try {
      await otp.sendCode({
        contact: target,
        respondentId: null,
        purpose: "account_password_reset",
      });
    } catch (error) {
      // Do not reveal whether an account exists by returning a different HTTP
      // status when its delivery provider rejects a message. Cooldowns also
      // deliberately look the same as a fresh request; the previously issued
      // code remains the code the respondent should use.
      if (error.code !== "COOLDOWN") {
        console.warn(`Password reset code delivery failed for account ${account.id}: ${error.message}`);
      }
    }
  }

  res.json({ ok: true, simulated, ttlMinutes: otp.TTL_MINUTES });
});

router.post("/auth/verify", async (req, res) => {
  const suppliedContact = String(req.body.contact || "").trim();
  const code = String(req.body.code || "").trim();
  if (!suppliedContact || !code) return res.status(400).json({ error: "Enter the code we sent you." });

  const account = await accounts.findByContact(suppliedContact);
  if (!account) return res.status(400).json({ error: "That code isn't right." });

  const result = await otp.verifyCode({
    contact: deliveryContact(account, suppliedContact),
    code,
    purpose: "account_password_reset",
  });
  if (!result.ok) return res.status(400).json({ error: result.reason || "That code isn't right." });

  const ticket = await mobileAuth.issuePasswordResetTicket(account.id);
  logAudit(`account:${account.contact}`, "account_password_reset_verified", "respondent_accounts", account.id, {});
  res.json({ resetToken: ticket.token, expiresAt: ticket.expiresAt });
});

router.post("/auth/reset-password", async (req, res) => {
  const resetToken = String(req.body.resetToken || "").trim();
  const password = String(req.body.password || "");
  if (!resetToken) return res.status(400).json({ error: "Please verify your code again." });

  const accountId = await mobileAuth.consumePasswordResetTicket(resetToken);
  if (!accountId) return res.status(400).json({ error: "That code has expired. Please request a new one." });

  try {
    await accounts.resetPassword(accountId, password);
  } catch (error) {
    return res.status(400).json({ error: error.message || "We couldn't reset your password. Please try again." });
  }

  await accounts.markVerified(accountId);
  const account = await accounts.getById(accountId);
  const session = await mobileAuth.issueSession({ accountId });
  logAudit(`account:${account.contact}`, "account_password_reset_completed", "respondent_accounts", account.id, {});
  res.json({ token: session.token, expiresAt: session.expiresAt, account: publicAccount(account) });
});

module.exports = router;

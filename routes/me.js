// Respondent account area: passwordless login and the list of studies a person
// is enrolled on.
//
// Login normally uses a one-time code. While Twilio is not yet configured the
// temporary respondent OTP switch can bypass that step; Admin/staff login is
// unaffected. Set RESPONDENT_OTP_BYPASS=false to restore normal verification.
const express = require("express");
const { logAudit } = require("../lib/audit");
const otp = require("../lib/otp");
const accounts = require("../lib/respondentAccounts");
const messaging = require("../lib/whatsapp");
const { isBypassed: respondentOtpBypassed } = require("../lib/respondentOtpMode");

const router = express.Router();

async function currentAccount(req) {
  return req.session.respondentAccountId ? accounts.getById(req.session.respondentAccountId) : null;
}

async function requireAccount(req, res, next) {
  const account = await currentAccount(req);
  if (!account) return res.redirect("/me/login");
  req.account = account;
  next();
}

router.get("/login", async (req, res) => {
  if (await currentAccount(req)) return res.redirect("/me");
  res.render("me/login", { error: null, contact: "", user: null });
});

router.post("/login", async (req, res) => {
  const contact = (req.body.contact || "").trim();
  const fail = (error) => res.status(400).render("me/login", { error, contact, user: null });
  if (!contact) return fail("Enter the phone number or email you signed up with.");

  const account = await accounts.findByContact(contact);

  if (respondentOtpBypassed()) {
    if (!account) return fail("We couldn't find an INICIO respondent account for that contact.");
    await accounts.markVerified(account.id);
    req.session.respondentAccountId = account.id;
    delete req.session.pendingLoginContact;
    logAudit(`account:${account.contact}`, "respondent_login_otp_bypassed", "respondent_accounts", account.id, {});
    return res.redirect("/me");
  }

  // Deliberately does NOT say whether the account exists when OTP is enabled.
  if (account) {
    try {
      await otp.sendCode({ contact, respondentId: null, purpose: "account_login" });
    } catch (e) {
      if (e.code !== "COOLDOWN") {
        return fail(e.message || "We couldn't send a code just now. Please try again in a moment.");
      }
    }
  }
  req.session.pendingLoginContact = contact;
  res.redirect("/me/verify");
});

router.get("/verify", async (req, res) => {
  if (await currentAccount(req)) return res.redirect("/me");
  if (respondentOtpBypassed()) return res.redirect("/me/login");
  if (!req.session.pendingLoginContact) return res.redirect("/me/login");
  res.render("me/verify", {
    contact: req.session.pendingLoginContact,
    error: null,
    notice: req.query.resent ? "A new code is on its way." : null,
    simulated: !messaging.isRealMessagingConfigured(),
    ttlMinutes: otp.TTL_MINUTES,
    user: null,
  });
});

router.post("/verify", async (req, res) => {
  const contact = req.session.pendingLoginContact;
  if (!contact) return res.redirect("/me/login");

  if (respondentOtpBypassed()) {
    const account = await accounts.findByContact(contact);
    if (!account) return res.redirect("/me/login");
    await accounts.markVerified(account.id);
    req.session.respondentAccountId = account.id;
    delete req.session.pendingLoginContact;
    logAudit(`account:${account.contact}`, "respondent_login_otp_bypassed", "respondent_accounts", account.id, {});
    return res.redirect("/me");
  }

  const render = (error) =>
    res.status(400).render("me/verify", {
      contact, error, notice: null,
      simulated: !messaging.isRealMessagingConfigured(),
      ttlMinutes: otp.TTL_MINUTES, user: null,
    });

  const result = await otp.verifyCode({ contact, code: req.body.code, purpose: "account_login" });
  if (!result.ok) return render(result.reason);

  const account = await accounts.findByContact(contact);
  if (!account) return render("That code isn't right.");

  await accounts.markVerified(account.id);
  req.session.respondentAccountId = account.id;
  delete req.session.pendingLoginContact;
  logAudit(`account:${account.contact}`, "respondent_login", "respondent_accounts", account.id, {});
  res.redirect("/me");
});

router.post("/verify/resend", async (req, res) => {
  const contact = req.session.pendingLoginContact;
  if (!contact) return res.redirect("/me/login");
  if (respondentOtpBypassed()) return res.redirect("/me/login");
  if (await accounts.findByContact(contact)) {
    try {
      await otp.sendCode({ contact, respondentId: null, purpose: "account_login" });
    } catch (e) {
      return res.status(e.code === "COOLDOWN" ? 429 : 502).render("me/verify", {
        contact, error: e.message, notice: null,
        simulated: !messaging.isRealMessagingConfigured(),
        ttlMinutes: otp.TTL_MINUTES, user: null,
      });
    }
  }
  res.redirect("/me/verify?resent=1");
});

router.post("/logout", (req, res) => {
  delete req.session.respondentAccountId;
  delete req.session.pendingLoginContact;
  res.redirect("/me/login");
});

router.get("/", requireAccount, async (req, res) => {
  res.render("me/studies", {
    account: req.account,
    enrolments: await accounts.enrolmentsFor(req.account.id),
    user: null,
  });
});

module.exports = router;

// Respondent account area: passwordless login and the list of studies a person
// is enrolled on.
//
// Login is by one-time code to the contact on the account -- no passwords.
// That reuses the OTP machinery already built for remote onboarding, avoids a
// password-reset flow (which would need the same real SMS/email provider
// anyway), and suits a phone-first audience who would otherwise be locked out
// by a forgotten password with no easy way back in.
//
// The magic-link route (/r/:token) is untouched and still works: a
// face-to-face recruit gets a usable diary in the field without anyone
// creating a login. Accounts are an addition, not a replacement.
const express = require("express");
const db = require("../lib/db");
const { logAudit } = require("../lib/audit");
const otp = require("../lib/otp");
const accounts = require("../lib/respondentAccounts");
const messaging = require("../lib/whatsapp");

const router = express.Router();

function currentAccount(req) {
  return req.session.respondentAccountId ? accounts.getById(req.session.respondentAccountId) : null;
}

function requireAccount(req, res, next) {
  const account = currentAccount(req);
  if (!account) return res.redirect("/me/login");
  req.account = account;
  next();
}

// ---- Login: step 1, who are you ----
router.get("/login", (req, res) => {
  if (currentAccount(req)) return res.redirect("/me");
  res.render("me/login", { error: null, contact: "", user: null });
});

router.post("/login", async (req, res) => {
  const contact = (req.body.contact || "").trim();
  const fail = (error) => res.status(400).render("me/login", { error, contact, user: null });
  if (!contact) return fail("Enter the phone number or email you signed up with.");

  const account = accounts.findByContact(contact);
  // Deliberately does NOT say whether the account exists. Otherwise this page
  // becomes a way to test whether a given phone number is on a study, which
  // leaks participation -- and participation in a consumption study is exactly
  // the sort of thing a respondent expects to stay private.
  if (account) {
    try {
      await otp.sendCode({ contact, respondentId: null, purpose: "account_login" });
    } catch (e) {
      if (e.code !== "COOLDOWN") {
        // The provider's own reason (bad number format, region not enabled)
        // is shown: it's about the contact typed into this box, which the
        // person already knows, so it reveals nothing about who has an account.
        return fail(e.message || "We couldn't send a code just now. Please try again in a moment.");
      }
    }
  }
  req.session.pendingLoginContact = contact;
  res.redirect("/me/verify");
});

// ---- Login: step 2, the code ----
router.get("/verify", (req, res) => {
  if (currentAccount(req)) return res.redirect("/me");
  if (!req.session.pendingLoginContact) return res.redirect("/me/login");
  res.render("me/verify", {
    contact: req.session.pendingLoginContact,
    error: null,
    notice: req.query.resent ? "A new code is on its way." : null,
    // A property of the deployment, not of any account -- shown the same way
    // whether or not this contact has one, so it leaks nothing while still
    // saving someone from watching a phone that will never ring.
    simulated: !messaging.isRealMessagingConfigured(),
    ttlMinutes: otp.TTL_MINUTES,
    user: null,
  });
});

router.post("/verify", (req, res) => {
  const contact = req.session.pendingLoginContact;
  if (!contact) return res.redirect("/me/login");
  const render = (error) =>
    res.status(400).render("me/verify", {
      contact, error, notice: null,
      simulated: !messaging.isRealMessagingConfigured(),
      ttlMinutes: otp.TTL_MINUTES, user: null,
    });

  const result = otp.verifyCode({ contact, code: req.body.code, purpose: "account_login" });
  if (!result.ok) return render(result.reason);

  // Only now look the account up. A correct code for a contact with no account
  // is treated the same as a wrong one, so the earlier non-disclosure isn't
  // undone at this step.
  const account = accounts.findByContact(contact);
  if (!account) return render("That code isn't right.");

  accounts.markVerified(account.id);
  req.session.respondentAccountId = account.id;
  delete req.session.pendingLoginContact;
  logAudit(`account:${account.contact}`, "respondent_login", "respondent_accounts", account.id, {});
  res.redirect("/me");
});

router.post("/verify/resend", async (req, res) => {
  const contact = req.session.pendingLoginContact;
  if (!contact) return res.redirect("/me/login");
  if (accounts.findByContact(contact)) {
    try {
      await otp.sendCode({ contact, respondentId: null, purpose: "account_login" });
    } catch (e) {
      // 429 fits the cooldown; a provider refusal is a 502. Both show the
      // reason rather than a cheerful "on its way" for a code that isn't.
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

// ---- My studies ----
router.get("/", requireAccount, (req, res) => {
  res.render("me/studies", {
    account: req.account,
    enrolments: accounts.enrolmentsFor(req.account.id),
    user: null,
  });
});

module.exports = router;

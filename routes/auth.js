const express = require("express");
const bcrypt = require("bcryptjs");
const store = require("../lib/store");
const { logAudit } = require("../lib/audit");
const { qrDataUrl } = require("../lib/qrcode");
const { appBaseUrl } = require("../lib/urls");
const accounts = require("../lib/respondentAccounts");
const mobileAuth = require("../lib/mobileAuth");
const { isBypassed: respondentOtpBypassed } = require("../lib/respondentOtpMode");
const router = express.Router();

router.use("/webhooks/twilio/whatsapp", require("./whatsappWebhook"));
router.use("/api/mobile/profile", require("./mobileProfileApi"));
router.use("/api/mobile/respondents/:id", require("./mobileProfileGate"));

// Temporary pilot path while Twilio is not yet configured. The Expo app still
// submits the respondent's contact, but when RESPONDENT_OTP_BYPASS is on we
// issue the normal mobile bearer session immediately instead of sending or
// asking for a one-time code. Set RESPONDENT_OTP_BYPASS=false to restore the
// normal mobileApi OTP endpoints below.
router.post("/api/mobile/auth/request-code", async (req, res, next) => {
  if (!respondentOtpBypassed()) return next();
  const contact = String(req.body.contact || "").trim();
  if (!contact) return res.status(400).json({ error: "Enter your phone number or email." });

  const account = await accounts.findByContact(contact);
  if (!account) {
    return res.status(400).json({ error: "We couldn't find an INICIO respondent account for that contact." });
  }

  await accounts.markVerified(account.id);
  const session = await mobileAuth.issueSession({ accountId: account.id });
  logAudit(`account:${account.contact}`, "mobile_login_otp_bypassed", "respondent_accounts", account.id, {});
  res.json({
    ok: true,
    bypassed: true,
    simulated: true,
    ttlMinutes: 0,
    token: session.token,
    expiresAt: session.expiresAt,
    account: { id: account.id, name: account.name || null, contact: account.contact },
  });
});

router.use("/api/mobile", require("./mobileApi"));
router.use("/join", require("./joinProfile"));
router.use("/admin/panel", require("./panelAdmin"));

router.get("/login", (req, res) =>
  res.render("login", {
    error: null,
    user: null,
    // Seeded demo accounts must never be printed on a production sign-in page.
    // Four working staff logins -- one of them superadmin, who can delete
    // studies -- on a public URL is not a demo affordance, it is an open door.
    showDemoAccounts: process.env.NODE_ENV !== "production",
  })
);

// Password recovery.
//
// Deliberately NOT a self-serve email reset: no mail provider is configured,
// so a "check your inbox" screen would be a promise the app cannot keep --
// exactly the failure mode the OTP honesty work already fixed once. Staff
// passwords are reset by an admin, and this page says so plainly rather than
// leaving someone waiting for mail that never arrives.
router.get("/forgot-password", (req, res) =>
  res.render("forgot_password", { user: null })
);
router.get("/get-app", async (req, res) => {
  const url = appBaseUrl(req) + "/login";
  let qr = null;
  try { qr = await qrDataUrl(url, 280); } catch (e) { qr = null; }
  res.render("get_app", { url, qr, user: null });
});
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await store.findOne("users", { email: (email || "").trim().toLowerCase() });
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) return res.render("login", { error: "Invalid email or password.", user: null, showDemoAccounts: process.env.NODE_ENV !== "production" });
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, study_id: user.study_id };
  logAudit(user.email, "login", "users", user.id, {});

  // A temporary password gets you exactly one place: the screen where you
  // replace it. Anything else and a password an admin generated stays live on
  // the account indefinitely.
  // Flagged on the session, not just checked here: redirecting only at login
  // leaves the temporary password fully usable to anyone who then types a URL
  // directly. server.js enforces it on every request.
  if (user.must_change_password) {
    req.session.mustChangePassword = true;
    return res.redirect("/change-password");
  }

  if (user.role === "admin") return res.redirect("/admin");
  if (user.role === "interviewer") return res.redirect("/interviewer");
  if (user.role === "client") return res.redirect("/client");
  res.redirect("/");
});
router.get("/change-password", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.render("change_password", { user: null, error: null });
});

router.post("/change-password", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  const { password, confirm } = req.body;
  const fail = (error) => res.render("change_password", { user: null, error });

  if (!password || password.length < 8) return fail("Use at least 8 characters.");
  if (password !== confirm) return fail("Those two passwords don't match.");

  const me = await store.findOne("users", { id: req.session.user.id });
  // Reusing the temporary password would leave an admin-known credential live
  // on the account, which is the exact thing this screen exists to end.
  if (me && bcrypt.compareSync(password, me.password_hash)) {
    return fail("Choose something different from your temporary password.");
  }

  await store.update("users", { id: req.session.user.id }, {
    password_hash: bcrypt.hashSync(password, 10),
    must_change_password: 0,
  });
  delete req.session.mustChangePassword;
  logAudit(req.session.user.email, "change_own_password", "users", req.session.user.id, {});

  const role = req.session.user.role;
  if (role === "admin" || role === "superadmin") return res.redirect("/admin");
  if (role === "interviewer") return res.redirect("/interviewer");
  if (role === "client") return res.redirect("/client");
  res.redirect("/");
});

router.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
module.exports = router;

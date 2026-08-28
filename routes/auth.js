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

router.get("/login", (req, res) => res.render("login", { error: null, user: null }));
router.get("/get-app", async (req, res) => {
  const url = appBaseUrl(req) + "/login";
  let qr = null;
  try { qr = await qrDataUrl(url, 280); } catch (e) { qr = null; }
  res.render("get_app", { url, qr, user: null });
});
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await store.findOne("users", { email: (email || "").trim().toLowerCase() });
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) return res.render("login", { error: "Invalid email or password.", user: null });
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, study_id: user.study_id };
  logAudit(user.email, "login", "users", user.id, {});
  if (user.role === "admin") return res.redirect("/admin");
  if (user.role === "interviewer") return res.redirect("/interviewer");
  if (user.role === "client") return res.redirect("/client");
  res.redirect("/");
});
router.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
module.exports = router;

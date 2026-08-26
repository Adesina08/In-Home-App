const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../lib/db");
const { logAudit } = require("../lib/audit");
const { qrDataUrl } = require("../lib/qrcode");
const { appBaseUrl } = require("../lib/urls");

const router = express.Router();

router.get("/login", (req, res) => {
  res.render("login", { error: null, user: null });
});

// Public, no-login page: a QR code + link for opening the app on a phone and
// installing it as a PWA ("Add to Home Screen"). There's no native iOS/Android
// app to publish to an app store -- this page is the closest equivalent, and
// works for any role (a respondent handed this link, or field staff wanting
// the app shortcut on their own phone). Respondents recruited normally still
// get their own personal diary link/QR from their interviewer -- that link is
// what actually opens their diary; this one just opens the app's login/entry
// screen.
router.get("/get-app", async (req, res) => {
  const url = appBaseUrl(req) + "/login";
  let qr = null;
  try {
    qr = await qrDataUrl(url, 280);
  } catch (e) {
    qr = null; // Page still renders fine with just the plain link if QR generation fails for any reason.
  }
  res.render("get_app", { url, qr, user: null });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get((email || "").trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.render("login", { error: "Invalid email or password.", user: null });
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, study_id: user.study_id };
  logAudit(user.email, "login", "users", user.id, {});
  if (user.role === "admin") return res.redirect("/admin");
  if (user.role === "interviewer") return res.redirect("/interviewer");
  if (user.role === "client") return res.redirect("/client");
  res.redirect("/");
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;

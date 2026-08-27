const express = require("express");
const bcrypt = require("bcryptjs");
const store = require("../lib/store");
const { logAudit } = require("../lib/audit");
const { qrDataUrl } = require("../lib/qrcode");
const { appBaseUrl } = require("../lib/urls");

const router = express.Router();

// Native Expo respondent API. Mounted here because routes/auth.js is already
// public at the application root; each protected mobile endpoint performs its
// own bearer-token check inside routes/mobileApi.js rather than relying on the
// browser session used by staff/admin pages.
router.use("/api/mobile", require("./mobileApi"));

router.get("/login", (req, res) => {
  res.render("login", { error: null, user: null });
});

// Public, no-login page: a QR code + link for opening the app on a phone and
// installing it as a PWA ("Add to Home Screen"). The Expo respondent APK lives
// in expo-mobile/; this page remains the browser/PWA fallback and staff entry
// point. Respondents recruited normally still get their own personal diary
// link/QR from their interviewer -- that link is also accepted by the native
// app's Diary link sign-in option.
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

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await store.findOne("users", { email: (email || "").trim().toLowerCase() });
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

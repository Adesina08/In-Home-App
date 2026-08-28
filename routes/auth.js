const express = require("express");
const bcrypt = require("bcryptjs");
const store = require("../lib/store");
const { logAudit } = require("../lib/audit");
const { qrDataUrl } = require("../lib/qrcode");
const { appBaseUrl } = require("../lib/urls");
const router = express.Router();

router.use("/webhooks/twilio/whatsapp", require("./whatsappWebhook"));
router.use("/api/mobile/profile", require("./mobileProfileApi"));
router.use("/api/mobile/respondents/:id", require("./mobileProfileGate"));
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

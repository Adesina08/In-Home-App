const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../lib/db");
const { logAudit } = require("../lib/audit");

const router = express.Router();

router.get("/login", (req, res) => {
  res.render("login", { error: null, user: null });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get((email || "").trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.render("login", { error: "Invalid email or password.", user: null });
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, study_id: user.study_id };
  logAudit(user.email, "login", "users", user.id, {});
  if (user.role === "admin" || user.role === "research") return res.redirect("/admin");
  if (user.role === "interviewer") return res.redirect("/interviewer");
  if (user.role === "client") return res.redirect("/client");
  res.redirect("/");
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;

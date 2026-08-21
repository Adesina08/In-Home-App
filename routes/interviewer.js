const express = require("express");
const { v4: uuidv4 } = require("uuid");
const db = require("../lib/db");
const { requireRole } = require("../lib/auth");
const { logAudit } = require("../lib/audit");
const { qrDataUrl } = require("../lib/qrcode");
const { respondentDiaryUrl } = require("../lib/urls");

const router = express.Router();
router.use(requireRole("interviewer", "admin", "research"));

function genRespondentCode(studyId) {
  const count = db.prepare("SELECT COUNT(*) c FROM respondents WHERE study_id = ?").get(studyId).c;
  return `R${String(studyId).padStart(2, "0")}-${String(count + 1).padStart(4, "0")}`;
}

router.get("/", (req, res) => {
  const studies = db.prepare("SELECT * FROM studies WHERE status != 'closed' ORDER BY id").all();
  const mine = db
    .prepare(
      `SELECT respondents.*, studies.name as study_name FROM respondents
       JOIN studies ON studies.id = respondents.study_id
       WHERE respondents.interviewer_id = ? ORDER BY respondents.id DESC`
    )
    .all(req.session.user.id);
  res.render("interviewer/dashboard", { studies, mine });
});

router.get("/register", (req, res) => {
  const studies = db.prepare("SELECT * FROM studies WHERE status != 'closed' ORDER BY id").all();
  const studyId = req.query.study || (studies[0] && studies[0].id);
  const study = studies.find((s) => s.id == studyId);
  const consent = study
    ? db.prepare("SELECT * FROM consent_versions WHERE study_id = ? AND status='approved' ORDER BY version DESC LIMIT 1").get(study.id)
    : null;
  res.render("interviewer/register", { studies, study, consent });
});

// F2F flow: Screen -> Consent -> Register -> Verify -> Activate, captured as one submission for the pilot demo
router.post("/register", async (req, res) => {
  const { study_id, name, contact, eligible, consent_given, preferred_channel, practice } = req.body;
  if (!eligible) {
    return res.render("interviewer/register", {
      studies: db.prepare("SELECT * FROM studies").all(),
      study: db.prepare("SELECT * FROM studies WHERE id=?").get(study_id),
      consent: null,
      error: "Respondent screened as not eligible. Recruitment stopped (screen stage).",
    });
  }
  const token = uuidv4();
  const code = genRespondentCode(study_id);
  const info = db
    .prepare(
      `INSERT INTO respondents (study_id, respondent_code, name, contact, recruitment_mode, preferred_channel,
        consent_status, activation_status, unique_token, interviewer_id, is_practice)
       VALUES (?, ?, ?, ?, 'f2f', ?, ?, 'activated', ?, ?, ?)`
    )
    .run(
      study_id, code, name, contact, preferred_channel || "app",
      consent_given ? "given" : "declined", token, req.session.user.id, practice ? 1 : 0
    );
  logAudit(req.session.user.email, "f2f_onboard", "respondents", info.lastInsertRowid, { name, code });
  const diaryUrl = respondentDiaryUrl(req, token);
  // QR generation is a pure image-render, not a network call -- if it ever
  // did throw, better to still show the activation screen (with a plain
  // link) than lose the fact that the respondent was successfully registered.
  let qr = null;
  try {
    qr = await qrDataUrl(diaryUrl);
  } catch (e) {
    console.error("QR generation failed:", e);
  }
  res.render("interviewer/activated", { code, token, respondentId: info.lastInsertRowid, diaryUrl, qr });
});

module.exports = router;

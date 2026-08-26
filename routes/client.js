const express = require("express");
const db = require("../lib/db");
const { requireRole } = require("../lib/auth");
const { classifyRisk } = require("../lib/qc");
const { latestSummary } = require("../lib/aiSummary");
const kpiEngine = require("../lib/kpi");

const router = express.Router();
router.use(requireRole("client", "admin"));

router.get("/", (req, res) => {
  const scopedStudyId = req.session.user.study_id;
  const studies = scopedStudyId
    ? [db.prepare("SELECT * FROM studies WHERE id = ?").get(scopedStudyId)]
    : db.prepare("SELECT * FROM studies ORDER BY id").all();
  const studyId = parseInt(req.query.study, 10) || (studies[0] && studies[0].id);
  const study = studies.find((s) => s.id === studyId) || studies[0];
  if (!study) return res.render("error", { message: "No study assigned to your account yet.", user: req.session.user });

  const kpis = db.prepare("SELECT * FROM kpi_config WHERE study_id = ? AND enabled = 1").all(study.id);
  // Questionnaire-driven KPIs are computed here (lib/kpi.js); the original six
  // are still derived from the study-level counts below. Before this the view
  // held a hardcoded map of those six, so every KPI an admin added rendered a
  // permanent em-dash.
  const kpiComputed = kpiEngine.computeAll(study.id, kpis).results;

  const totalRespondents = db.prepare("SELECT COUNT(*) c FROM respondents WHERE study_id = ? AND is_practice = 0").get(study.id).c;
  const activeRespondents = db
    .prepare("SELECT COUNT(*) c FROM respondents WHERE study_id = ? AND is_practice = 0 AND activation_status IN ('active','activated')")
    .get(study.id).c;
  const totalDiaries = db.prepare("SELECT COUNT(*) c FROM diary_records WHERE study_id = ? AND is_practice = 0").get(study.id).c;
  const submittedDiaries = db
    .prepare("SELECT COUNT(*) c FROM diary_records WHERE study_id = ? AND status = 'submitted' AND is_practice = 0")
    .get(study.id).c;
  const completionRate = totalDiaries ? Math.round((submittedDiaries / totalDiaries) * 100) : 0;

  const flaggedRecords = db
    .prepare(
      `SELECT COUNT(DISTINCT qf.record_id) c FROM qc_flags qf JOIN respondents r ON r.id = qf.respondent_id
       WHERE r.study_id = ? AND qf.status = 'open' AND r.is_practice = 0 AND qf.record_id IS NOT NULL`
    )
    .get(study.id).c;
  const qcFlagRate = totalDiaries ? Math.round((flaggedRecords / totalDiaries) * 100) : 0;

  const avgOccasionsPerWeek = activeRespondents ? Math.round((submittedDiaries / activeRespondents) * 10) / 10 : 0;

  const respondents = db.prepare("SELECT id FROM respondents WHERE study_id = ? AND is_practice = 0").all(study.id);
  const riskCounts = { green: 0, amber: 0, red: 0 };
  respondents.forEach((r) => riskCounts[classifyRisk(r.id)]++);

  const brandQ = db.prepare("SELECT * FROM questions WHERE study_id = ? AND code = 'brand'").get(study.id);
  let brandConsumption = [];
  if (brandQ) {
    brandConsumption = db
      .prepare(
        `SELECT responses.value as brand, COUNT(*) mentions FROM responses
         JOIN diary_records dr ON dr.id = responses.record_id
         WHERE responses.question_id = ? AND dr.status = 'submitted' AND dr.is_practice = 0
         GROUP BY responses.value ORDER BY mentions DESC`
      )
      .all(brandQ.id);
  }

  const occasionQ = db.prepare("SELECT * FROM questions WHERE study_id = ? AND code = 'occasion'").get(study.id);
  let occasionMix = [];
  if (occasionQ) {
    occasionMix = db
      .prepare(
        `SELECT responses.value as occasion, COUNT(*) c FROM responses
         JOIN diary_records dr ON dr.id = responses.record_id
         WHERE responses.question_id = ? AND dr.status = 'submitted' AND dr.is_practice = 0
         GROUP BY responses.value ORDER BY c DESC`
      )
      .all(occasionQ.id);
  }

  const trend = db
    .prepare(
      `SELECT substr(entry_time,1,10) as day, COUNT(*) c FROM diary_records
       WHERE study_id = ? AND status='submitted' AND is_practice = 0 GROUP BY day ORDER BY day`
    )
    .all(study.id);

  // Spec 5.2 "AI insight": the client sees the most recent summary the
  // research team generated -- read-only, and never generated on their behalf,
  // so nothing reaches a client that research hasn't looked at first.
  const aiInsight = latestSummary(study.id);

  res.render("client/dashboard", {
    study,
    studies,
    kpis,
    kpiComputed,
    aiInsight,
    totalRespondents,
    activeRespondents,
    completionRate,
    qcFlagRate,
    avgOccasionsPerWeek,
    riskCounts,
    brandConsumption,
    occasionMix,
    trend,
  });
});

module.exports = router;

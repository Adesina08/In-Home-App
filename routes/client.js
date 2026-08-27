const express = require("express");
const store = require("../lib/store");
const { requireRole } = require("../lib/auth");
const { classifyRisk } = require("../lib/qc");
const { latestSummary } = require("../lib/aiSummary");
const kpiEngine = require("../lib/kpi");

const router = express.Router();
router.use(requireRole("client", "admin"));

router.get("/", async (req, res) => {
  const scopedStudyId = req.session.user.study_id;
  const studies = scopedStudyId
    ? [await store.findOne("studies", { id: scopedStudyId })]
    : await store.find("studies", {}, { sort: { id: 1 } });
  const studyId = parseInt(req.query.study, 10) || (studies[0] && studies[0].id);
  const study = studies.find((s) => s.id === studyId) || studies[0];
  if (!study) return res.render("error", { message: "No study assigned to your account yet.", user: req.session.user });

  const kpis = await store.find("kpi_config", { study_id: study.id, enabled: 1 }, { sort: { id: 1 } });
  // Questionnaire-driven KPIs are computed here (lib/kpi.js); the original six
  // are still derived from the study-level counts below. Before this the view
  // held a hardcoded map of those six, so every KPI an admin added rendered a
  // permanent em-dash.
  const kpiComputed = (await kpiEngine.computeAll(study.id, kpis)).results;

  const totalRespondents = await store.count("respondents", { study_id: study.id, is_practice: 0 });
  const activeRespondents = await store.count("respondents", {
    study_id: study.id,
    is_practice: 0,
    activation_status: { $in: ["active", "activated"] },
  });
  const totalDiaries = await store.count("diary_records", { study_id: study.id, is_practice: 0 });
  const submittedDiaries = await store.count("diary_records", {
    study_id: study.id,
    status: "submitted",
    is_practice: 0,
  });
  const completionRate = totalDiaries ? Math.round((submittedDiaries / totalDiaries) * 100) : 0;

  // JOIN done in JS: the study's non-practice respondents, then the open flags
  // belonging to them. COUNT(DISTINCT qf.record_id) becomes a Set of record ids.
  const flaggedRespondents = await store.find(
    "respondents",
    { study_id: study.id, is_practice: 0 },
    { projection: { id: 1 } }
  );
  const flaggedRespondentIds = new Set(flaggedRespondents.map((r) => r.id));
  const openFlags = await store.find("qc_flags", { status: "open", record_id: { $ne: null } });
  const flaggedRecords = new Set(
    openFlags.filter((f) => flaggedRespondentIds.has(f.respondent_id)).map((f) => f.record_id)
  ).size;
  const qcFlagRate = totalDiaries ? Math.round((flaggedRecords / totalDiaries) * 100) : 0;

  const avgOccasionsPerWeek = activeRespondents ? Math.round((submittedDiaries / activeRespondents) * 10) / 10 : 0;

  const respondents = await store.find("respondents", { study_id: study.id, is_practice: 0 }, { projection: { id: 1 } });
  const riskCounts = { green: 0, amber: 0, red: 0 };
  // classifyRisk is async now, so the forEach becomes a sequential loop.
  for (const r of respondents) {
    riskCounts[await classifyRisk(r.id)]++;
  }

  // The two tallies below joined responses to diary_records; the submitted,
  // non-practice records are fetched once here and matched in JS.
  const submittedRecords = await store.find(
    "diary_records",
    { status: "submitted", is_practice: 0 },
    { projection: { id: 1 } }
  );
  const submittedRecordIds = new Set(submittedRecords.map((d) => d.id));

  const brandQ = await store.findOne("questions", { study_id: study.id, code: "brand" });
  let brandConsumption = [];
  if (brandQ) {
    const brandRows = await store.find("responses", { question_id: brandQ.id }, { sort: { id: 1 } });
    const brandTally = new Map();
    for (const row of brandRows) {
      if (!submittedRecordIds.has(row.record_id)) continue;
      brandTally.set(row.value, (brandTally.get(row.value) || 0) + 1);
    }
    // GROUP BY responses.value ORDER BY mentions DESC
    brandConsumption = [...brandTally.entries()]
      .map(([brand, mentions]) => ({ brand, mentions }))
      .sort((a, b) => b.mentions - a.mentions);
  }

  const occasionQ = await store.findOne("questions", { study_id: study.id, code: "occasion" });
  let occasionMix = [];
  if (occasionQ) {
    const occasionRows = await store.find("responses", { question_id: occasionQ.id }, { sort: { id: 1 } });
    const occasionTally = new Map();
    for (const row of occasionRows) {
      if (!submittedRecordIds.has(row.record_id)) continue;
      occasionTally.set(row.value, (occasionTally.get(row.value) || 0) + 1);
    }
    // GROUP BY responses.value ORDER BY c DESC
    occasionMix = [...occasionTally.entries()]
      .map(([occasion, c]) => ({ occasion, c }))
      .sort((a, b) => b.c - a.c);
  }

  // GROUP BY substr(entry_time,1,10) ORDER BY day -- done in JS, since the
  // store has no SQL string functions to group on.
  const trendRecords = await store.find("diary_records", {
    study_id: study.id,
    status: "submitted",
    is_practice: 0,
  });
  const trendTally = new Map();
  for (const rec of trendRecords) {
    const day = String(rec.entry_time).slice(0, 10);
    trendTally.set(day, (trendTally.get(day) || 0) + 1);
  }
  const trend = [...trendTally.entries()]
    .map(([day, c]) => ({ day, c }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  // Spec 5.2 "AI insight": the client sees the most recent summary the
  // research team generated -- read-only, and never generated on their behalf,
  // so nothing reaches a client that research hasn't looked at first.
  const aiInsight = await latestSummary(study.id);

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

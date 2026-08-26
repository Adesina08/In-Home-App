// Rule-based QC engine. Deterministic, transparent rules only (per spec: no ML
// models required before the QC workflow is usable). Every rule reads its
// thresholds from the study config (Developer > QC Thresholds) rather than
// being hardcoded, so research teams can tune them per study.

const db = require("./db");
const { logAudit } = require("./audit");

function hoursBetween(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 36e5;
}

function raiseFlag(respondentId, recordId, flagType, severity, reason) {
  db.prepare(
    `INSERT INTO qc_flags (respondent_id, record_id, flag_type, severity, reason) VALUES (?, ?, ?, ?, ?)`
  ).run(respondentId, recordId || null, flagType, severity, reason);
  logAudit("qc-engine", "flag_raised", "qc_flags", null, { respondentId, recordId, flagType, severity, reason });
}

// Run all P0 QC checks against a just-submitted diary record.
function runQcForRecord(recordId) {
  const record = db.prepare("SELECT * FROM diary_records WHERE id = ?").get(recordId);
  if (!record) return;
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(record.study_id);
  const respondent = db.prepare("SELECT * FROM respondents WHERE id = ?").get(record.respondent_id);

  // Each rule below can be switched off per study (Settings & Thresholds).
  // Disabled means the rule genuinely doesn't run -- not that its output is
  // hidden -- so a study that turns one off has no flags of that type at all,
  // rather than a quietly filtered worklist.

  // 1. Timeliness / recall: entry outside allowed back-entry window
  if (study.qc_back_entry_enabled && record.occurrence_time && record.entry_time) {
    const gap = hoursBetween(record.occurrence_time, record.entry_time);
    if (gap > study.back_entry_hours) {
      raiseFlag(
        respondent.id,
        record.id,
        "back_entry_window_breach",
        gap > study.back_entry_hours * 2 ? "high" : "medium",
        `Entry logged ${gap.toFixed(1)}h after occurrence; allowed window is ${study.back_entry_hours}h`
      );
    }
  }

  // 2. Photo evidence missing when mandatory
  if (study.mandatory_photo) {
    const media = db.prepare("SELECT COUNT(*) c FROM media WHERE record_id = ?").get(record.id);
    if (media.c === 0) {
      raiseFlag(respondent.id, record.id, "missing_photo_evidence", "high", "Mandatory photo evidence not attached to this record");
    }
  }

  // 3. Burst entry: many past periods entered in a short window
  if (study.qc_burst_enabled) {
    const recentCount = db
      .prepare(
        `SELECT COUNT(*) c FROM diary_records
         WHERE respondent_id = ? AND datetime(entry_time) >= datetime(?, '-' || ? || ' hours')`
      )
      .get(respondent.id, record.entry_time, study.burst_entry_window_hours);
    if (recentCount.c > study.burst_entry_count_threshold) {
      raiseFlag(
        respondent.id,
        record.id,
        "burst_entry",
        "medium",
        `${recentCount.c} diary entries submitted within ${study.burst_entry_window_hours}h (threshold ${study.burst_entry_count_threshold})`
      );
    }
  }

  // 4. Duplicate / repetitive: compare text/numeric responses against the respondent's previous record
  if (study.qc_duplicate_enabled) {
    const prevRecord = db
      .prepare(
        `SELECT id FROM diary_records WHERE respondent_id = ? AND id != ? AND status = 'submitted'
         ORDER BY datetime(entry_time) DESC LIMIT 1`
      )
      .get(respondent.id, record.id);
    if (prevRecord) {
      const curr = db.prepare("SELECT question_id, value FROM responses WHERE record_id = ?").all(record.id);
      const prev = db.prepare("SELECT question_id, value FROM responses WHERE record_id = ?").all(prevRecord.id);
      const prevMap = Object.fromEntries(prev.map((r) => [r.question_id, r.value]));
      let matches = 0;
      let total = 0;
      for (const r of curr) {
        if (prevMap[r.question_id] !== undefined) {
          total++;
          if (prevMap[r.question_id] === r.value) matches++;
        }
      }
      const similarity = total > 0 ? matches / total : 0;
      if (similarity >= study.duplicate_similarity_threshold && total >= 3) {
        raiseFlag(
          respondent.id,
          record.id,
          "duplicate_repetitive",
          "high",
          `${(similarity * 100).toFixed(0)}% of answers identical to previous submitted record (threshold ${(study.duplicate_similarity_threshold * 100).toFixed(0)}%)`
        );
      }
    }
  }

  // 5. Logic / range checks against question min/max
  const responses = db
    .prepare(
      `SELECT r.value, q.text, q.min_value, q.max_value, q.type FROM responses r
       JOIN questions q ON q.id = r.question_id WHERE r.record_id = ?`
    )
    .all(record.id);
  for (const r of responses) {
    if (r.type === "numeric" && r.value !== null && r.value !== "") {
      const v = parseFloat(r.value);
      if ((r.min_value !== null && v < r.min_value) || (r.max_value !== null && v > r.max_value)) {
        raiseFlag(respondent.id, record.id, "range_logic", "medium", `"${r.text}" answered ${v}, outside allowed range [${r.min_value}, ${r.max_value}]`);
      }
    }
  }

  // 6. Required fields missing. Photo/video/audio questions are evidence: they're
  // tracked in the media table rather than as a row in responses, so checking them
  // here would flag every one of them as unanswered.
  const requiredQs = db
    .prepare("SELECT id, text FROM questions WHERE study_id = ? AND required = 1 AND active = 1 AND type NOT IN ('photo', 'video', 'audio')")
    .all(study.id);
  const answered = new Set(db.prepare("SELECT question_id FROM responses WHERE record_id = ?").all(record.id).map((r) => r.question_id));
  for (const q of requiredQs) {
    if (!answered.has(q.id)) {
      raiseFlag(respondent.id, record.id, "incomplete_diary", "medium", `Required question "${q.text}" left unanswered`);
    }
  }
}

// Cross-channel duplicate: same occasion (period_label) submitted on more than one channel
function checkCrossChannelDuplicate(respondentId, periodLabel) {
  const rows = db
    .prepare(
      `SELECT DISTINCT channel FROM diary_records WHERE respondent_id = ? AND period_label = ? AND status = 'submitted'`
    )
    .all(respondentId, periodLabel);
  if (rows.length > 1) {
    raiseFlag(respondentId, null, "cross_channel_duplicate", "critical", `Occasion "${periodLabel}" submitted via multiple channels: ${rows.map((r) => r.channel).join(", ")}`);
  }
}

// Recruitment / identity checks, run at the moment a respondent is registered
// (spec 4.1 row 1: "Consent missing; duplicate phone/respondent/household ->
// Hold activation / review"). Returns the reasons activation must be held, so
// the caller can register the respondent but leave them un-activated rather
// than silently letting a duplicate or unconsented person into the sample.
//
// Deliberately does NOT reject the registration outright: an interviewer in
// the field shouldn't lose the data they just captured, and a "duplicate"
// can legitimately be a second person in the same household sharing a phone
// number. Research reviews and releases the hold from Admin > Respondents.
function checkRecruitmentIdentity({ studyId, contact, consentGiven, excludeRespondentId }) {
  const holds = [];

  if (!consentGiven) {
    holds.push({
      flagType: "consent_missing",
      severity: "critical",
      reason: "Registered without recorded consent — no diary collection may begin until consent is captured.",
    });
  }

  const normalized = String(contact || "").replace(/[\s\-()]/g, "").toLowerCase();
  if (normalized) {
    // Compare on a normalized contact so "+234 801 234 5678" and
    // "08012345678"-style variants of the same number still collide.
    const existing = db
      .prepare(
        `SELECT id, respondent_code, name FROM respondents
         WHERE study_id = ?
           AND id != ?
           AND lower(replace(replace(replace(replace(contact,' ',''),'-',''),'(',''),')','')) = ?`
      )
      .all(studyId, excludeRespondentId || 0, normalized);
    if (existing.length) {
      holds.push({
        flagType: "duplicate_identity",
        severity: "critical",
        reason: `Contact matches ${existing.length} existing respondent(s) in this study: ${existing
          .map((e) => `${e.respondent_code}${e.name ? ` (${e.name})` : ""}`)
          .join(", ")}. Confirm this is a different person before activating.`,
      });
    }
  }

  return holds;
}

// Apply the recruitment checks to a respondent that has just been created:
// raises a flag per hold and, if there are any, leaves them un-activated.
// Returns the holds so the caller can tell the interviewer what happened.
function applyRecruitmentHolds(respondentId, { studyId, contact, consentGiven }) {
  const holds = checkRecruitmentIdentity({ studyId, contact, consentGiven, excludeRespondentId: respondentId });
  holds.forEach((h) => raiseFlag(respondentId, null, h.flagType, h.severity, h.reason));
  if (holds.length) {
    db.prepare("UPDATE respondents SET activation_status = 'registered' WHERE id = ?").run(respondentId);
  }
  return holds;
}

// Critical/high flags still blocking closure (spec 4.1 "End validation":
// "Hold ... closure until reviewed"). The bar is *reviewed*, not resolved:
// a flag someone has looked at and consciously dispositioned no longer blocks,
// even if it stays on the books as a known issue. Only 'open' -- nobody has
// looked at it yet -- holds the study open.
// Scoped to a whole study, or to one respondent.
function unresolvedBlockingFlags({ studyId, respondentId }) {
  if (respondentId) {
    return db
      .prepare(
        `SELECT qc_flags.*, respondents.respondent_code FROM qc_flags
         JOIN respondents ON respondents.id = qc_flags.respondent_id
         WHERE qc_flags.respondent_id = ? AND qc_flags.status = 'open'
           AND qc_flags.severity IN ('critical','high')
         ORDER BY qc_flags.created_time DESC`
      )
      .all(respondentId);
  }
  return db
    .prepare(
      `SELECT qc_flags.*, respondents.respondent_code FROM qc_flags
       JOIN respondents ON respondents.id = qc_flags.respondent_id
       WHERE respondents.study_id = ? AND qc_flags.status = 'open'
         AND qc_flags.severity IN ('critical','high')
       ORDER BY qc_flags.created_time DESC`
    )
    .all(studyId);
}

// Green / Amber / Red classification, derived live from open QC flags (not stored).
function classifyRisk(respondentId) {
  const flags = db.prepare("SELECT severity FROM qc_flags WHERE respondent_id = ? AND status = 'open'").all(respondentId);
  const critical = flags.filter((f) => f.severity === "critical").length;
  const high = flags.filter((f) => f.severity === "high").length;
  const medium = flags.filter((f) => f.severity === "medium").length;
  if (critical > 0 || high >= 2) return "red";
  if (high >= 1 || medium >= 2) return "amber";
  return "green";
}

module.exports = {
  runQcForRecord,
  checkCrossChannelDuplicate,
  classifyRisk,
  raiseFlag,
  checkRecruitmentIdentity,
  applyRecruitmentHolds,
  unresolvedBlockingFlags,
};

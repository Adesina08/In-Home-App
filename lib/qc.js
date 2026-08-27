// Rule-based QC engine. Deterministic, transparent rules only (per spec: no ML
// models required before the QC workflow is usable). Every rule reads its
// thresholds from the study config (Developer > QC Thresholds) rather than
// being hardcoded, so research teams can tune them per study.

const store = require("./store");
const { logAudit } = require("./audit");

function hoursBetween(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 36e5;
}

// SQLite did the burst-window arithmetic inside the query, as
// datetime(?, '-' || ? || ' hours'). There is no SQL to run that in any more,
// so the cutoff is computed here. Stored timestamps are 'YYYY-MM-DD HH:MM:SS'
// in UTC, so the string is read as UTC and written back in the same
// fixed-width format -- which is what keeps a plain `>=` on the stored strings
// meaning exactly what datetime(...) >= datetime(...) meant.
function sqlTimeMinusHours(sqlTime, hours) {
  const t = Date.parse(`${String(sqlTime).replace(" ", "T")}Z`);
  if (isNaN(t)) return null;
  return new Date(t - hours * 36e5).toISOString().replace("T", " ").slice(0, 19);
}

async function raiseFlag(respondentId, recordId, flagType, severity, reason) {
  await store.insert("qc_flags", {
    respondent_id: respondentId,
    record_id: recordId || null,
    flag_type: flagType,
    severity,
    reason,
  });
  logAudit("qc-engine", "flag_raised", "qc_flags", null, { respondentId, recordId, flagType, severity, reason });
}

// Run all P0 QC checks against a just-submitted diary record.
async function runQcForRecord(recordId) {
  const record = await store.findOne("diary_records", { id: recordId });
  if (!record) return;
  const study = await store.findOne("studies", { id: record.study_id });
  const respondent = await store.findOne("respondents", { id: record.respondent_id });

  // Each rule below can be switched off per study (Settings & Thresholds).
  // Disabled means the rule genuinely doesn't run -- not that its output is
  // hidden -- so a study that turns one off has no flags of that type at all,
  // rather than a quietly filtered worklist.

  // 1. Timeliness / recall: entry outside allowed back-entry window
  if (study.qc_back_entry_enabled && record.occurrence_time && record.entry_time) {
    const gap = hoursBetween(record.occurrence_time, record.entry_time);
    if (gap > study.back_entry_hours) {
      await raiseFlag(
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
    const media = await store.count("media", { record_id: record.id });
    if (media === 0) {
      await raiseFlag(respondent.id, record.id, "missing_photo_evidence", "high", "Mandatory photo evidence not attached to this record");
    }
  }

  // 3. Burst entry: many past periods entered in a short window
  if (study.qc_burst_enabled) {
    const burstCutoff = sqlTimeMinusHours(record.entry_time, study.burst_entry_window_hours);
    // A missing/unparseable entry_time made the SQL comparison NULL, so no row
    // was counted; keep that rather than counting every entry the person has.
    const recentCount = burstCutoff
      ? await store.count("diary_records", { respondent_id: respondent.id, entry_time: { $gte: burstCutoff } })
      : 0;
    if (recentCount > study.burst_entry_count_threshold) {
      await raiseFlag(
        respondent.id,
        record.id,
        "burst_entry",
        "medium",
        `${recentCount} diary entries submitted within ${study.burst_entry_window_hours}h (threshold ${study.burst_entry_count_threshold})`
      );
    }
  }

  // 4. Duplicate / repetitive: compare text/numeric responses against the respondent's previous record
  if (study.qc_duplicate_enabled) {
    // ORDER BY datetime(entry_time) DESC is a plain descending sort on the
    // stored string: the format is fixed-width UTC, so it sorts chronologically.
    const prevRecord = await store.findOne(
      "diary_records",
      { respondent_id: respondent.id, id: { $ne: record.id }, status: "submitted" },
      { sort: { entry_time: -1 } }
    );
    if (prevRecord) {
      const curr = await store.find("responses", { record_id: record.id }, { projection: { question_id: 1, value: 1 } });
      const prev = await store.find("responses", { record_id: prevRecord.id }, { projection: { question_id: 1, value: 1 } });
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
        await raiseFlag(
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
  // The responses -> questions join is done in JS; the store has no joins. It
  // was an inner join, so a response whose question no longer exists is still
  // dropped, and the rows keep their scanned (id) order so flags are raised in
  // the same sequence. A column that was never set comes back undefined rather
  // than the NULL SQLite returned, so it is normalised back to null -- the
  // range checks and the message below both read it.
  const responseRows = await store.find("responses", { record_id: record.id }, { sort: { id: 1 } });
  const responseQuestions = await store.find("questions", { id: { $in: [...new Set(responseRows.map((r) => r.question_id))] } });
  const responseQuestionsById = new Map(responseQuestions.map((q) => [q.id, q]));
  const responses = [];
  for (const row of responseRows) {
    const q = responseQuestionsById.get(row.question_id);
    if (!q) continue;
    responses.push({
      value: row.value,
      text: q.text,
      min_value: q.min_value === undefined ? null : q.min_value,
      max_value: q.max_value === undefined ? null : q.max_value,
      type: q.type,
    });
  }
  for (const r of responses) {
    if (r.type === "numeric" && r.value !== null && r.value !== "") {
      const v = parseFloat(r.value);
      if ((r.min_value !== null && v < r.min_value) || (r.max_value !== null && v > r.max_value)) {
        await raiseFlag(respondent.id, record.id, "range_logic", "medium", `"${r.text}" answered ${v}, outside allowed range [${r.min_value}, ${r.max_value}]`);
      }
    }
  }

  // 6. Required fields missing. Photo/video/audio questions are evidence: they're
  // tracked in the media table rather than as a row in responses, so checking them
  // here would flag every one of them as unanswered.
  const requiredQs = await store.find(
    "questions",
    { study_id: study.id, required: 1, active: 1, type: { $nin: ["photo", "video", "audio"] } },
    { sort: { id: 1 } }
  );
  const answered = new Set(
    (await store.find("responses", { record_id: record.id }, { projection: { question_id: 1 } })).map((r) => r.question_id)
  );
  for (const q of requiredQs) {
    if (!answered.has(q.id)) {
      await raiseFlag(respondent.id, record.id, "incomplete_diary", "medium", `Required question "${q.text}" left unanswered`);
    }
  }
}

// Cross-channel duplicate: same occasion (period_label) submitted on more than one channel
async function checkCrossChannelDuplicate(respondentId, periodLabel) {
  // SELECT DISTINCT channel done in JS, so the channels stay in the order the
  // rows were scanned in -- that order is what the flag text lists them in.
  const records = await store.find(
    "diary_records",
    { respondent_id: respondentId, period_label: periodLabel, status: "submitted" },
    { sort: { id: 1 } }
  );
  const rows = [...new Set(records.map((r) => r.channel))];
  if (rows.length > 1) {
    await raiseFlag(respondentId, null, "cross_channel_duplicate", "critical", `Occasion "${periodLabel}" submitted via multiple channels: ${rows.join(", ")}`);
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
async function checkRecruitmentIdentity({ studyId, contact, consentGiven, excludeRespondentId }) {
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
    //
    // This was a SQL lower(replace(replace(...))) comparison. MongoDB has no
    // equivalent string functions in a filter, so the study's respondents are
    // fetched and normalised here instead, with the same rules. A NULL contact
    // never matched in SQL (NULL = x is NULL), so a respondent without one is
    // skipped rather than normalising to "".
    const candidates = await store.find(
      "respondents",
      { study_id: studyId, id: { $ne: excludeRespondentId || 0 } },
      { sort: { id: 1 }, projection: { id: 1, respondent_code: 1, name: 1, contact: 1 } }
    );
    const existing = candidates.filter(
      (r) =>
        r.contact !== null &&
        r.contact !== undefined &&
        String(r.contact).replace(/[\s\-()]/g, "").toLowerCase() === normalized
    );
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
async function applyRecruitmentHolds(respondentId, { studyId, contact, consentGiven }) {
  const holds = await checkRecruitmentIdentity({ studyId, contact, consentGiven, excludeRespondentId: respondentId });
  for (const h of holds) {
    await raiseFlag(respondentId, null, h.flagType, h.severity, h.reason);
  }
  if (holds.length) {
    await store.update("respondents", { id: respondentId }, { activation_status: "registered" });
  }
  return holds;
}

// Critical/high flags still blocking closure (spec 4.1 "End validation":
// "Hold ... closure until reviewed"). The bar is *reviewed*, not resolved:
// a flag someone has looked at and consciously dispositioned no longer blocks,
// even if it stays on the books as a known issue. Only 'open' -- nobody has
// looked at it yet -- holds the study open.
// Scoped to a whole study, or to one respondent.
async function unresolvedBlockingFlags({ studyId, respondentId }) {
  // The JOIN onto respondents -- for respondent_code, and to scope by study --
  // is done in JS. It was an inner join, so a flag whose respondent row is
  // missing is still dropped.
  if (respondentId) {
    const respondent = await store.findOne("respondents", { id: respondentId });
    if (!respondent) return [];
    const flags = await store.find(
      "qc_flags",
      { respondent_id: respondentId, status: "open", severity: { $in: ["critical", "high"] } },
      { sort: { created_time: -1 } }
    );
    return flags.map((f) => ({ ...f, respondent_code: respondent.respondent_code }));
  }
  const respondents = await store.find("respondents", { study_id: studyId }, { projection: { id: 1, respondent_code: 1 } });
  const byId = new Map(respondents.map((r) => [r.id, r]));
  const flags = await store.find(
    "qc_flags",
    { respondent_id: { $in: [...byId.keys()] }, status: "open", severity: { $in: ["critical", "high"] } },
    { sort: { created_time: -1 } }
  );
  return flags.map((f) => ({ ...f, respondent_code: byId.get(f.respondent_id).respondent_code }));
}

// Green / Amber / Red classification, derived live from open QC flags (not stored).
async function classifyRisk(respondentId) {
  const flags = await store.find("qc_flags", { respondent_id: respondentId, status: "open" }, { projection: { severity: 1 } });
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

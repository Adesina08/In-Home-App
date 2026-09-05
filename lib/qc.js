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
// Expected diary periods per cadence, from activation to now. This is
// deliberately a rough estimate -- a study's real reminder schedule (quiet
// hours, holidays, a respondent's own back-entry window) can shift the true
// expectation, and re-deriving all of that here would duplicate the reminder
// engine's own logic and could drift from it. It exists to give compliance a
// denominator, not to be the system of record for what was actually due.
function expectedPeriodsSoFar(respondent, study) {
  if (!respondent.activation_time && !respondent.created_at) return 0;
  const since = new Date(String(respondent.activation_time || respondent.created_at).replace(" ", "T"));
  const days = Math.max(0, (Date.now() - since.getTime()) / 86400000);
  const perDay = { realtime: 1, daily: 1, weekly: 1 / 7, monthly: 1 / 30, hybrid: 1 }[study.diary_mode] || 1;
  return Math.max(1, Math.round(days * perDay));
}

/**
 * A single 0-100 quality score for a respondent, combining the QC dimensions
 * this platform actually has real signal for:
 *
 *   compliance (35%)  -- submitted entries vs. how many were expected by now
 *   flag load   (35%) -- open QC flags, weighted by severity (this alone
 *                        already reflects completeness, duplicate rate and
 *                        logic consistency, since those are exactly what
 *                        raiseFlag() is called for elsewhere in this file)
 *   follow-through (15%) -- submitted vs. abandoned-as-draft
 *   media validity (15%) -- media whose AI processing came back an actual
 *                        error, not "unavailable" (mock mode / unconfigured
 *                        providers must never be scored as a quality problem)
 *
 * Duration-based checks from the spec (minimum plausible completion time) are
 * NOT included -- nothing in this app currently times how long a respondent
 * spends on a question, so a duration score would have to be invented rather
 * than measured. Left out rather than faked.
 */
async function computeQualityScore(respondentId) {
  const respondent = await store.findOne("respondents", { id: respondentId });
  if (!respondent) return null;
  const study = await store.findOne("studies", { id: respondent.study_id });

  const [submitted, drafts, openFlags, media] = await Promise.all([
    store.count("diary_records", { respondent_id: respondentId, status: "submitted", is_practice: 0 }),
    store.count("diary_records", { respondent_id: respondentId, status: "draft", is_practice: 0 }),
    store.find("qc_flags", { respondent_id: respondentId, status: "open" }, { projection: { severity: 1 } }),
    store.find("media", { record_id: { $in: (await store.find("diary_records", { respondent_id: respondentId }, { projection: { id: 1 } })).map((r) => r.id) } }),
  ]);

  const expected = expectedPeriodsSoFar(respondent, study);
  const complianceScore = expected ? Math.min(100, Math.round((submitted / expected) * 100)) : 100;

  const penalties = { critical: 25, high: 12, medium: 5, low: 2 };
  const flagPenalty = openFlags.reduce((sum, f) => sum + (penalties[f.severity] || 2), 0);
  const flagScore = Math.max(0, 100 - flagPenalty);

  const followThroughScore = submitted + drafts > 0 ? Math.round((submitted / (submitted + drafts)) * 100) : 100;

  const mediaWithStatus = media.filter((m) => m.transcript_status === "error" || m.detection_status === "error" || m.transcript_status === "done" || m.detection_status === "done");
  const mediaErrors = media.filter((m) => m.transcript_status === "error" || m.detection_status === "error").length;
  const mediaScore = mediaWithStatus.length ? Math.round(((mediaWithStatus.length - mediaErrors) / mediaWithStatus.length) * 100) : 100;

  const score = Math.round(
    complianceScore * 0.35 + flagScore * 0.35 + followThroughScore * 0.15 + mediaScore * 0.15
  );

  const band =
    score >= 85 ? "high_confidence" :
    score >= 70 ? "acceptable" :
    score >= 50 ? "at_risk" : "high_risk";

  return {
    score,
    band,
    breakdown: { complianceScore, flagScore, followThroughScore, mediaScore, expected, submitted, drafts, openFlagCount: openFlags.length },
  };
}

const BAND_LABELS = {
  high_confidence: "High confidence",
  acceptable: "Acceptable, minor flags",
  at_risk: "At risk",
  high_risk: "High risk",
};

// Every screen built before this feature existed reads green/amber/red, and
// rewriting all of them in one pass is out of scope here. This bucket keeps
// those screens working -- correctly, on the new score -- while the four real
// bands (and the underlying number) are available anywhere that shows more
// than a colour, via computeQualityScore() directly.
function bandToLegacyColor(band) {
  if (band === "high_confidence" || band === "acceptable") return "green";
  if (band === "at_risk") return "amber";
  return "red";
}

async function classifyRisk(respondentId) {
  const result = await computeQualityScore(respondentId);
  return result ? bandToLegacyColor(result.band) : "green";
}

// Flag types that mean "this needs a human conversation", not just a
// researcher clicking Resolve -- the spec's own list: late, incomplete,
// inconsistent or unclear. Cross-referenced against the actual flag_type
// strings raiseFlag() uses elsewhere in this file.
const FOLLOW_UP_FLAG_TYPES = [
  "back_entry_window_breach", // late
  "incomplete_diary",         // incomplete
  "range_logic",               // inconsistent
  "burst_entry",                // unclear / suspicious pattern
  "cross_channel_duplicate",   // unclear
  "missing_photo_evidence",    // incomplete
];

const FOLLOW_UP_AGE_HOURS = 48;

/**
 * Whether a respondent belongs in the exception follow-up queue: they have an
 * open, follow-up-worthy flag that has sat unresolved past the age threshold.
 * A flag raised five minutes ago is not yet an exception -- automated
 * reminders and digital clarification get the first chance, per spec 10.5.
 */
function isFollowUpWorthy(flag) {
  if (flag.status !== "open") return false;
  if (!FOLLOW_UP_FLAG_TYPES.includes(flag.flag_type)) return false;
  const ageHours = (Date.now() - new Date(String(flag.created_time).replace(" ", "T")).getTime()) / 3600000;
  return ageHours >= FOLLOW_UP_AGE_HOURS;
}

/**
 * The queue itself: one row per respondent who has at least one follow-up-
 * worthy flag, with every such flag attached, their current quality score,
 * and their most recent logged contact attempt if any -- so a researcher can
 * see at a glance whether this person was already called yesterday.
 *
 * Deliberately separate from the general QC Worklist (GET /admin/qc): that
 * screen is every open flag of every severity; this is the much smaller list
 * of who actually needs a phone call, which is the entire point of an
 * exception queue -- concentrating effort rather than working every flag in
 * flag-creation order.
 */
async function exceptionFollowUpQueue(studyId) {
  const respondents = await store.find(
    "respondents",
    { study_id: studyId },
    { projection: { id: 1, respondent_code: 1, name: 1, contact: 1 } }
  );
  const byId = new Map(respondents.map((r) => [r.id, r]));

  const flags = await store.find(
    "qc_flags",
    { respondent_id: { $in: [...byId.keys()] }, status: "open" },
    { sort: { created_time: 1 } }
  );

  const worthyByRespondent = new Map();
  for (const f of flags) {
    if (!isFollowUpWorthy(f)) continue;
    if (!worthyByRespondent.has(f.respondent_id)) worthyByRespondent.set(f.respondent_id, []);
    worthyByRespondent.get(f.respondent_id).push(f);
  }
  if (!worthyByRespondent.size) return [];

  const lastContacts = await store.find(
    "follow_up_log",
    { respondent_id: { $in: [...worthyByRespondent.keys()] } },
    { sort: { created_at: -1 } }
  );
  const lastContactByRespondent = new Map();
  for (const c of lastContacts) {
    if (!lastContactByRespondent.has(c.respondent_id)) lastContactByRespondent.set(c.respondent_id, c);
  }

  const queue = [];
  for (const [respondentId, respondentFlags] of worthyByRespondent.entries()) {
    const respondent = byId.get(respondentId);
    if (!respondent) continue;
    const quality = await computeQualityScore(respondentId);
    queue.push({
      respondent,
      flags: respondentFlags,
      oldestFlagHours: Math.round(
        (Date.now() - new Date(String(respondentFlags[0].created_time).replace(" ", "T")).getTime()) / 3600000
      ),
      quality,
      lastContact: lastContactByRespondent.get(respondentId) || null,
    });
  }
  // Oldest unresolved exception first -- that is the respondent whose window
  // for a useful clarification call is closing fastest.
  queue.sort((a, b) => b.oldestFlagHours - a.oldestFlagHours);
  return queue;
}

module.exports = {
  runQcForRecord,
  checkCrossChannelDuplicate,
  classifyRisk,
  computeQualityScore,
  bandToLegacyColor,
  BAND_LABELS,
  exceptionFollowUpQueue,
  isFollowUpWorthy,
  FOLLOW_UP_FLAG_TYPES,
  raiseFlag,
  checkRecruitmentIdentity,
  applyRecruitmentHolds,
  unresolvedBlockingFlags,
};

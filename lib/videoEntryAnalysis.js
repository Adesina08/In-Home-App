// Analyses a submitted video entry AFTER the respondent has gone.
//
// Video mode used to make the respondent wait through frame extraction, five
// Vision calls, audio extraction and a Speech call, then hand them a pre-filled
// form to check. That is a long stare at a spinner on a phone connection, and
// it turned "record a video" into "record a video and then fill in the form
// anyway". Submit now ends the respondent's involvement; this runs behind them.
//
// The trade that comes with it: nobody verifies the AI's answers at the point
// of entry. So every field written here is marked `source: "ai_video"` and
// `verified: 0`, and raises a QC flag for a researcher to confirm. A client
// must never see a machine's guess presented as something a respondent said.

const store = require("./store");
const { getProvider } = require("./videoFieldExtraction");

async function analyzeSubmittedVideo({ recordId, videoFile, questions, brands, studyVersion }) {
  let result;
  try {
    result = await getProvider().analyze(videoFile, questions, brands);
  } catch (e) {
    result = { status: "error", prefill: {}, transcript: "", note: `AI video review failed: ${e.message}` };
  }

  const prefill = result.prefill || {};
  const filled = [];

  for (const q of questions) {
    const value = prefill[q.code];
    if (value === undefined || value === null || value === "") continue;
    // A response row may already exist if the entry carried answers; never
    // overwrite something a person actually chose with a machine's guess.
    const existing = await store.findOne("responses", { record_id: recordId, question_id: q.id });
    if (existing && existing.value) continue;

    await store.insert("responses", {
      record_id: recordId,
      question_id: q.id,
      value: Array.isArray(value) ? value.join("|") : String(value),
      study_version: studyVersion,
      source: "ai_video",
      verified: 0,
    });
    filled.push(q.code);
  }

  if (result.transcript) {
    await store.update("diary_records", { id: recordId }, { video_transcript: result.transcript });
  }

  // One flag per record, not one per field: a worklist with six rows for the
  // same video is noise, and the reviewer opens the entry either way.
  await store.insert("qc_flags", {
    record_id: recordId,
    flag_type: "ai_answers_unverified",
    severity: filled.length ? "medium" : "low",
    created_time: store.nowSql(),
    status: "open",
    detail: filled.length
      ? `Video review answered ${filled.length} question${filled.length === 1 ? "" : "s"} (${filled.join(", ")}) with no respondent confirmation. Check against the video before this entry is analysed.`
      : "Video review could not answer any question from this video. The entry has no answers beyond the video itself.",
  });

  return { filled, status: result.status };
}

module.exports = { analyzeSubmittedVideo };

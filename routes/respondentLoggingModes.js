const express = require("express");

// Product rule for Inicio Diary:
// - Standard is the normal questionnaire flow.
// - Video is the only capture-first alternative.
// - Audio remains a QUESTION type inside Standard and is automatically sent
//   to the configured transcription provider by routes/respondent.js.
//
// Keep this guard ahead of the legacy respondent router so old bookmarks or
// manually edited URLs using ?mode=audio cannot bring the retired standalone
// audio/voice-note logging format back into the respondent experience.
const router = express.Router();

router.get("/:token/diary/new", (req, res, next) => {
  if (req.query.mode !== "audio") return next();
  const params = new URLSearchParams();
  params.set("mode", "standard");
  if (req.query.practice === "1") params.set("practice", "1");
  return res.redirect(`/r/${req.params.token}/diary/new?${params.toString()}`);
});

router.post("/:token/diary", (req, res, next) => {
  if (req.body && req.body._mode === "audio") req.body._mode = "standard";
  next();
});

module.exports = router;

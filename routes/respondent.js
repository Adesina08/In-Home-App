const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const db = require("../lib/db");
const { runQcForRecord, checkCrossChannelDuplicate } = require("../lib/qc");
const { logAudit } = require("../lib/audit");
const { getProvider: getBrandDetectionProvider } = require("../lib/brandDetection");
const { getProvider: getAudioTranscriptionProvider } = require("../lib/audioTranscription");
const { getProvider: getVideoFieldExtractionProvider } = require("../lib/videoFieldExtraction");
const { persistUpload } = require("../lib/mediaStorage");
const { loadQuestionnaire } = require("../lib/questionnaire");
const { findTerminateMatch } = require("../lib/skipLogic");
const webauthn = require("../lib/webauthn");
const push = require("../lib/push");

const router = express.Router();
// 60MB cap accommodates a short brand-evidence video clip from a phone camera, not just photos.
// UPLOAD_DIR (see server.js) lets this point at a durable path in production; defaults to the
// same local ./uploads dir as always for local/dev.
const uploadsRoot = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
const upload = multer({ dest: uploadsRoot, limits: { fileSize: 60 * 1024 * 1024 } });

function getRespondentByToken(token) {
  return db.prepare("SELECT * FROM respondents WHERE unique_token = ?").get(token);
}

// Per-respondent PWA manifest so "Add to Home Screen" reopens straight into
// this respondent's own diary link (a shared static manifest can't do that).
router.get("/:token/manifest.json", (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).json({ error: "not found" });
  res.set("Content-Type", "application/manifest+json");
  res.json({
    name: `INICIO Diary — ${respondent.respondent_code}`,
    short_name: "INICIO Diary",
    description: "Your in-home consumption diary.",
    start_url: `/r/${req.params.token}`,
    scope: "/r/",
    display: "standalone",
    background_color: "#F8FAFC",
    theme_color: "#1F3864",
    orientation: "portrait-primary",
    icons: [
      { src: "/public/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/public/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/public/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
});

// ---- Device lock (fingerprint / Face ID / device PIN via WebAuthn) ----
// Every respondent must lock their diary behind their device's own biometric/PIN
// check. Registration happens once per device; every later visit needs a fresh
// unlock (see the requireLock middleware below, applied to every other /:token
// route). A device with no platform authenticator at all (older phone, desktop
// with no fingerprint reader) can't have this enforced -- see the /lock/exempt
// route -- so this is "required everywhere it's technically possible," not a
// feature that can silently brick the pilot for someone's older phone.

router.get("/:token/lock", (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "This link is not valid. Please contact your interviewer.", user: null });
  const next = typeof req.query.next === "string" ? req.query.next : `/r/${req.params.token}`;
  if (respondent.biometric_exempt) return res.redirect(next);
  const hasCredential = webauthn.getCredentialsForRespondent(respondent.id).length > 0;
  return res.redirect(`/r/${req.params.token}/lock/${hasCredential ? "unlock" : "setup"}?next=${encodeURIComponent(next)}`);
});

router.get("/:token/lock/setup", (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(respondent.study_id);
  const next = typeof req.query.next === "string" ? req.query.next : `/r/${req.params.token}`;
  res.render("respondent/lock_setup", { respondent, study, next });
});

router.get("/:token/lock/unlock", (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(respondent.study_id);
  const next = typeof req.query.next === "string" ? req.query.next : `/r/${req.params.token}`;
  res.render("respondent/lock_unlock", { respondent, study, next });
});

router.post("/:token/lock/registration-options", async (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).json({ error: "Invalid link." });
  try {
    const options = await webauthn.buildRegistrationOptions(req, respondent);
    res.json(options);
  } catch (e) {
    console.error("WebAuthn registration-options failed:", e.message);
    res.status(500).json({ error: "Could not start device lock setup." });
  }
});

router.post("/:token/lock/registration-verify", async (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).json({ error: "Invalid link." });
  try {
    const ok = await webauthn.verifyRegistration(req, respondent, req.body);
    if (!ok) return res.status(400).json({ error: "Could not verify that device." });
    req.session.bioVerified = req.session.bioVerified || {};
    req.session.bioVerified[req.params.token] = true;
    res.json({ verified: true });
  } catch (e) {
    console.error("WebAuthn registration-verify failed:", e.message);
    res.status(400).json({ error: "Could not verify that device." });
  }
});

router.post("/:token/lock/auth-options", async (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).json({ error: "Invalid link." });
  try {
    const options = await webauthn.buildAuthenticationOptions(req, respondent);
    res.json(options);
  } catch (e) {
    console.error("WebAuthn auth-options failed:", e.message);
    res.status(500).json({ error: "Could not start unlock." });
  }
});

router.post("/:token/lock/auth-verify", async (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).json({ error: "Invalid link." });
  try {
    const ok = await webauthn.verifyAuthentication(req, respondent, req.body);
    if (!ok) return res.status(400).json({ error: "Unlock failed. Please try again." });
    req.session.bioVerified = req.session.bioVerified || {};
    req.session.bioVerified[req.params.token] = true;
    res.json({ verified: true });
  } catch (e) {
    console.error("WebAuthn auth-verify failed:", e.message);
    res.status(400).json({ error: "Unlock failed. Please try again." });
  }
});

// Only reached when the client-side check has confirmed this device has no
// platform authenticator at all -- there is nothing to "require" on hardware
// that doesn't support it, so this respondent is exempted and logged as such
// (visible via the respondents list) rather than being locked out entirely.
router.post("/:token/lock/exempt", (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).json({ error: "Invalid link." });
  db.prepare("UPDATE respondents SET biometric_exempt = 1 WHERE id = ?").run(respondent.id);
  logAudit(respondent.respondent_code, "biometric_lock_exempted", "respondents", respondent.id, {
    reason: "no platform authenticator available on this device",
  });
  req.session.bioVerified = req.session.bioVerified || {};
  req.session.bioVerified[req.params.token] = true;
  res.json({ exempted: true });
});

// Plain-language usage guide -- reachable regardless of lock state (someone
// stuck on the lock/unlock screen needs to be able to get help without first
// getting past it) and contains nothing respondent-specific or sensitive.
router.get("/:token/help", (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  res.render("respondent/help", { respondent, content: require("../lib/helpContent").respondent });
});

// Applied to every respondent route below this point (registered after the
// /lock/* and /help routes above, so those always stay reachable regardless of lock state).
router.use("/:token", (req, res, next) => {
  if (req.path === "/manifest.json" || req.path === "/help") return next(); // not sensitive
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return next(); // let the real route handler 404 normally
  // A study-scoped "Terminate survey" skip rule (see lib/skipLogic.js) sets this
  // when it fires -- the respondent's participation is over, so every route
  // below (home, new diary entry, consent, push subscribe...) shows the same
  // end screen instead of whatever was requested. Checked ahead of the
  // biometric lock gate below since there's nothing left to unlock into.
  if (respondent.activation_status === "disqualified") {
    return res.render("respondent/disqualified", { respondent });
  }
  // Held by a recruitment QC check (duplicate contact / consent not recorded --
  // see lib/qc.js applyRecruitmentHolds). They keep their link, but the diary
  // stays shut until research releases the hold from Admin > Respondents, so a
  // possible duplicate can't quietly start contributing data to the sample.
  if (respondent.activation_status === "registered") {
    return res.render("respondent/pending_activation", { respondent });
  }
  if (respondent.biometric_exempt) return next();
  if (req.session.bioVerified && req.session.bioVerified[req.params.token]) return next();
  const next_ = encodeURIComponent(req.originalUrl);
  return res.redirect(`/r/${req.params.token}/lock?next=${next_}`);
});

router.get("/:token", (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "This link is not valid. Please contact your interviewer.", user: null });
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(respondent.study_id);
  const consent = db.prepare("SELECT * FROM consent_versions WHERE study_id = ? AND status='approved' ORDER BY version DESC LIMIT 1").get(study.id);
  const records = db.prepare("SELECT * FROM diary_records WHERE respondent_id = ? ORDER BY datetime(entry_time) DESC").all(respondent.id);
  res.render("respondent/home", {
    respondent, study, consent, records,
    // Pre-existing gap: the post-submit redirect (see POST /:token/diary below)
    // has always appended ?saved=submitted|draft|screened_out, but this render
    // never forwarded it to the view, so home.ejs's confirmation banner never
    // actually appeared for anyone. Fixed here since the new "screened out"
    // banner depends on it too.
    saved: req.query.saved,
    pushEnabled: push.isEnabled(),
    vapidPublicKey: push.getPublicKey(),
  });
});

// ---- Diary reminder push notifications (Web Push / VAPID, see lib/push.js) ----
router.post("/:token/push/subscribe", (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).json({ error: "Invalid link." });
  const ok = push.saveSubscription(respondent.id, req.body, req.get("user-agent"));
  if (!ok) return res.status(400).json({ error: "Malformed subscription." });
  res.json({ subscribed: true });
});

router.post("/:token/push/unsubscribe", (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).json({ error: "Invalid link." });
  if (req.body && req.body.endpoint) push.removeSubscription(respondent.id, req.body.endpoint);
  res.json({ unsubscribed: true });
});

router.post("/:token/consent", (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  db.prepare("UPDATE respondents SET consent_status='given', activation_status='activated' WHERE id = ?").run(respondent.id);
  res.redirect(`/r/${req.params.token}`);
});

router.get("/:token/diary/new", (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(respondent.study_id);
  const mode = req.query.mode;
  const practice = req.query.practice === "1";

  // No mode chosen yet — let the respondent pick how they want to log this entry.
  if (!mode) {
    return res.render("respondent/diary_mode_picker", { respondent, study, practice });
  }

  // Video mode has its own capture-first screen (see POST /diary/analyze-video below);
  // standard and audio modes go straight to the question form.
  if (mode === "video") {
    return res.render("respondent/diary_video_capture", { respondent, study, practice });
  }

  const { questions, rules } = loadQuestionnaire(study.id);
  res.render("respondent/diary_form", {
    respondent, study, questions, rules, practice,
    mode: mode === "audio" ? "audio" : "standard",
    prefill: {}, pendingMedia: null, aiNote: null,
  });
});

// Video mode, step 1: respondent uploads one video, we run it through the
// (mocked, see lib/videoFieldExtraction.js) field-extraction provider, then
// render the same diary form pre-filled with whatever it could confidently
// pull out — everything else is left for the respondent to answer normally.
// The already-saved video is carried forward via hidden fields so it isn't
// re-uploaded; final POST /diary attaches it as evidence media.
router.post("/:token/diary/analyze-video", upload.single("video"), async (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(respondent.study_id);
  const { questions, rules } = loadQuestionnaire(study.id);
  const brands = db.prepare("SELECT * FROM brands WHERE study_id = ? AND active = 1").all(study.id);
  const practice = req.body.practice === "1";

  if (!req.file) {
    return res.render("respondent/diary_video_capture", {
      respondent, study, practice, error: "Please record or choose a video before continuing.",
    });
  }

  // Everything below can fail on a live provider call (a misconfigured Azure
  // resource, a network blip, a corrupt upload) — this whole block is wrapped
  // so any of that degrades to the standard-form experience with the video
  // still attached as evidence, instead of taking the whole app down. Express
  // 4 does NOT automatically catch a rejected promise from an async route
  // handler, so an uncaught throw here would crash the entire Node process
  // for every concurrent respondent, not just this one request.
  try {
    // Construct the provider (can throw synchronously — e.g. missing Azure
    // credentials — hence inside this try, not above it).
    const provider = getVideoFieldExtractionProvider();
    // Analyze the video while it's still a fresh local temp file (real bytes on
    // this machine — ffmpeg needs a path, not a storage-abstracted pointer),
    // THEN hand it off to permanent storage (local or Azure Blob, depending on
    // STORAGE_PROVIDER) so the analysis step never has to care where the file
    // ends up living.
    const result = await provider
      .analyze(req.file, questions, brands)
      .catch(() => ({ status: "error", prefill: {}, note: "AI video review failed — please answer the questions below." }));
    const storedPath = await persistUpload(req.file).catch(() => `/uploads/${req.file.filename}`);

    res.render("respondent/diary_form", {
      respondent, study, questions, rules, practice,
      mode: "video",
      prefill: result.prefill || {},
      pendingMedia: { path: storedPath, mimetype: req.file.mimetype },
      aiNote: result.note || null,
    });
  } catch (e) {
    // Provider construction itself failed (e.g. VIDEO_FIELD_EXTRACTION_PROVIDER=azure_vision
    // with no credentials set). Still let the respondent continue with a plain
    // form rather than dead-ending them — the video was uploaded, just not analyzed.
    const storedPath = await persistUpload(req.file).catch(() => `/uploads/${req.file.filename}`);
    res.render("respondent/diary_form", {
      respondent, study, questions, rules, practice,
      mode: "video",
      prefill: {},
      pendingMedia: { path: storedPath, mimetype: req.file.mimetype },
      aiNote: "AI video review is unavailable right now — please answer the questions below; your video is still attached as evidence.",
    });
  }
});

router.post("/:token/diary", upload.any(), async (req, res) => {
  const respondent = getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(respondent.study_id);
  const isSubmit = req.body._action === "submit";
  const isPractice = req.body._practice === "1" ? 1 : 0;
  const entryMode = ["standard", "video", "audio"].includes(req.body._mode) ? req.body._mode : "standard";
  const occurrenceTime = req.body.occurrence_time ? req.body.occurrence_time.replace("T", " ") : new Date().toISOString().slice(0, 19).replace("T", " ");
  const periodLabel = req.body.period_label || occurrenceTime.slice(0, 10);

  const questions = db.prepare("SELECT * FROM questions WHERE study_id = ? AND active = 1").all(study.id);

  // "Terminate survey" skip rules (see lib/skipLogic.js) are re-evaluated here
  // server-side, against the answers actually submitted, rather than trusted
  // from the diary form's client-side JS -- that JS only exists to hide the
  // rest of the form and swap in a "you're done" message the moment a
  // respondent picks a disqualifying answer; it can't be relied on for
  // anything that changes stored data, since a respondent's browser could
  // otherwise be made to skip or fake that check. Only checked on a real
  // Submit (not a draft save) -- a rule shouldn't screen someone out just
  // because they typed a disqualifying answer and then saved a draft.
  let terminateMatch = null;
  if (isSubmit) {
    const rules = db.prepare("SELECT sr.*, cq.text as condition_text FROM skip_rules sr JOIN questions cq ON cq.id = sr.condition_question_id WHERE sr.study_id = ?").all(study.id);
    const answers = {};
    questions.forEach((q) => {
      const field = `q_${q.id}`;
      if (q.type === "multi") {
        const vals = req.body[field];
        if (vals) answers[q.id] = (Array.isArray(vals) ? vals : [vals]).join("|");
      } else if (req.body[field] !== undefined && req.body[field] !== "") {
        answers[q.id] = req.body[field];
      }
    });
    terminateMatch = findTerminateMatch(rules, answers);
  }
  const isTerminated = !!terminateMatch;
  const terminateNote = isTerminated
    ? `Terminated: "${terminateMatch.condition_text}" ${{ equals: "=", not_equals: "≠", in: "is one of", not_in: "is none of", includes: "includes" }[terminateMatch.operator] || terminateMatch.operator} "${terminateMatch.value}"`
    : null;

  const info = db
    .prepare(
      `INSERT INTO diary_records (respondent_id, study_id, period_label, occurrence_time, submit_time, channel, status, is_practice, entry_mode, terminate_note)
       VALUES (?, ?, ?, ?, ?, 'app', ?, ?, ?, ?)`
    )
    .run(
      respondent.id, study.id, periodLabel, occurrenceTime,
      isSubmit ? new Date().toISOString().slice(0, 19).replace("T", " ") : null,
      isTerminated ? "screened_out" : (isSubmit ? "submitted" : "draft"), isPractice, entryMode, terminateNote
    );
  const recordId = info.lastInsertRowid;

  const insertResponse = db.prepare("INSERT INTO responses (record_id, question_id, value, study_version) VALUES (?, ?, ?, ?)");
  for (const q of questions) {
    const field = `q_${q.id}`;
    if (q.type === "multi") {
      const vals = req.body[field];
      if (vals) {
        const arr = Array.isArray(vals) ? vals : [vals];
        insertResponse.run(recordId, q.id, arr.join("|"), study.version);
      }
    } else if (q.type !== "photo" && q.type !== "video" && req.body[field] !== undefined && req.body[field] !== "") {
      insertResponse.run(recordId, q.id, req.body[field], study.version);
    }
  }

  const insertMedia = db.prepare(
    "INSERT INTO media (record_id, media_type, file_path) VALUES (?, ?, ?)"
  );
  const brands = db.prepare("SELECT * FROM brands WHERE study_id = ? AND active = 1").all(study.id);

  // AI enrichment (brand detection / transcription) is always best-effort and
  // must never block or crash a diary submission -- the diary record and the
  // respondent's actual answers are the data that matters. Provider
  // construction can throw synchronously (e.g. a real provider selected with
  // missing/invalid credentials); catch that here so a misconfigured Azure
  // resource degrades to "detection/transcription skipped" instead of
  // crashing the whole app for every respondent.
  let brandProvider = null;
  try { brandProvider = getBrandDetectionProvider(); } catch (e) { console.error("Brand detection provider unavailable:", e.message); }
  let audioProvider = null;
  try { audioProvider = getAudioTranscriptionProvider(); } catch (e) { console.error("Audio transcription provider unavailable:", e.message); }

  // Video mode: the video was already uploaded + analyzed in the /diary/analyze-video
  // step, and its saved path was carried forward via hidden fields — attach it here
  // rather than asking the respondent to upload it again.
  if (req.body._pending_media_path) {
    const mediaType = (req.body._pending_media_mimetype || "").startsWith("video/") ? "video" : "photo";
    const info2 = insertMedia.run(recordId, mediaType, req.body._pending_media_path);
    const mediaRow = { id: info2.lastInsertRowid, record_id: recordId, media_type: mediaType, file_path: req.body._pending_media_path };
    if (brandProvider) brandProvider.detect(mediaRow, brands).catch(() => {});
  }

  for (const f of req.files || []) {
    // Hand each upload off to permanent storage (local disk or Azure Blob,
    // depending on STORAGE_PROVIDER) before recording its path — falls back
    // to the local "/uploads/..." path if storage isn't reachable so a
    // submission never fails outright over a storage hiccup.
    const storedPath = await persistUpload(f).catch(() => `/uploads/${f.filename}`);

    if (f.fieldname === "audio_note") {
      const info2 = insertMedia.run(recordId, "audio", storedPath);
      const mediaRow = { id: info2.lastInsertRowid, record_id: recordId, media_type: "audio", file_path: storedPath };
      // Queue transcription for the respondent's optional voice note — runs inline
      // against the mock/Azure provider, see lib/audioTranscription.js.
      if (audioProvider) audioProvider.transcribe(mediaRow).catch(() => {});
      continue;
    }
    const mediaType = (f.mimetype || "").startsWith("video/") ? "video" : "photo";
    const info2 = insertMedia.run(recordId, mediaType, storedPath);
    const mediaRow = { id: info2.lastInsertRowid, record_id: recordId, media_type: mediaType, file_path: storedPath };
    // Queue brand detection for evidence that could show a product (photo or video).
    // Runs inline against the mock/Azure provider — see lib/brandDetection.js.
    if (brandProvider) brandProvider.detect(mediaRow, brands).catch(() => {});
  }

  if (isSubmit && !isPractice) {
    db.prepare("UPDATE respondents SET activation_status='active' WHERE id = ? AND activation_status != 'active'").run(respondent.id);
    // A screened-out entry is a deliberately incomplete/disqualified response,
    // not a real diary submission -- it shouldn't trip QC flags for missing
    // fields/evidence, or count toward the cross-channel-duplicate check.
    if (!isTerminated) {
      runQcForRecord(recordId);
      checkCrossChannelDuplicate(respondent.id, periodLabel);
    }
  }

  // A study-scoped terminate rule ends the respondent's participation
  // entirely (see the "Scope" choice on the Skip Logic rule) — every route
  // under /r/:token now shows the end screen instead (see the router.use
  // gate above) until/unless a staff member changes their status by hand.
  if (isTerminated && terminateMatch.terminate_scope === "study" && !isPractice) {
    db.prepare(
      "UPDATE respondents SET activation_status='disqualified', disqualified_at=datetime('now'), disqualify_reason=? WHERE id = ?"
    ).run(terminateNote, respondent.id);
  }

  logAudit(respondent.respondent_code, isTerminated ? "diary_terminated" : (isSubmit ? "diary_submit" : "diary_draft"), "diary_records", recordId, { practice: !!isPractice, terminateScope: isTerminated ? terminateMatch.terminate_scope : undefined });

  res.redirect(`/r/${req.params.token}?saved=${isTerminated ? "screened_out" : (isSubmit ? "submitted" : "draft")}`);
});

module.exports = router;

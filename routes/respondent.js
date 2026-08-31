const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const store = require("../lib/store");
const { runQcForRecord, checkCrossChannelDuplicate } = require("../lib/qc");
const { logAudit } = require("../lib/audit");
const { getProvider: getBrandDetectionProvider } = require("../lib/brandDetection");
const { getProvider: getAudioTranscriptionProvider } = require("../lib/audioTranscription");
const { buildVideoPrompts } = require("../lib/videoPrompts");
const { analyzeSubmittedVideo } = require("../lib/videoEntryAnalysis");
const { getProvider: getVideoFieldExtractionProvider } = require("../lib/videoFieldExtraction");
const { persistUpload } = require("../lib/mediaStorage");
const { loadQuestionnaire } = require("../lib/questionnaire");
const { findTerminateMatch } = require("../lib/skipLogic");
const { validateSubmission } = require("../lib/answerValidation");
const webauthn = require("../lib/webauthn");
const push = require("../lib/push");

const router = express.Router();
// 60MB cap accommodates a short brand-evidence video clip from a phone camera, not just photos.
// UPLOAD_DIR (see server.js) lets this point at a durable path in production; defaults to the
// same local ./uploads dir as always for local/dev.
const uploadsRoot = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
const upload = multer({ dest: uploadsRoot, limits: { fileSize: 60 * 1024 * 1024 } });

async function getRespondentByToken(token) {
  return store.findOne("respondents", { unique_token: token });
}

// Per-respondent PWA manifest so "Add to Home Screen" reopens straight into
// this respondent's own diary link (a shared static manifest can't do that).
router.get("/:token/manifest.json", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
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

// The native shell appends ?app=1 on the way in. Recorded on the session so
// every later request in the same launch is recognised, not just the first.
router.use("/:token", (req, res, next) => {
  if (req.query.app === "1") req.session.isNativeApp = true;
  next();
});

router.get("/:token/lock", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "This link is not valid. Please contact your interviewer.", user: null });
  const next = typeof req.query.next === "string" ? req.query.next : `/r/${req.params.token}`;
  if (respondent.biometric_exempt) return res.redirect(next);

  // No device lock inside the native app.
  //
  // The Capacitor WebView does not expose the WebAuthn credentials API, so
  // browserSupportsWebAuthn() returns false and the setup screen could only
  // ever flash up and exempt the respondent anyway. Skipping it outright is
  // the honest version of what was already happening -- and it no longer
  // writes a permanent exemption that would also disable the lock for the same
  // person in a real browser.
  if (req.session.isNativeApp) return res.redirect(next);
  const hasCredential = (await webauthn.getCredentialsForRespondent(respondent.id)).length > 0;
  return res.redirect(`/r/${req.params.token}/lock/${hasCredential ? "unlock" : "setup"}?next=${encodeURIComponent(next)}`);
});

router.get("/:token/lock/setup", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  const study = await store.findOne("studies", { id: respondent.study_id });
  const next = typeof req.query.next === "string" ? req.query.next : `/r/${req.params.token}`;
  res.render("respondent/lock_setup", { respondent, study, next });
});

router.get("/:token/lock/unlock", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  const study = await store.findOne("studies", { id: respondent.study_id });
  const next = typeof req.query.next === "string" ? req.query.next : `/r/${req.params.token}`;
  res.render("respondent/lock_unlock", { respondent, study, next });
});

router.post("/:token/lock/registration-options", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
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
  const respondent = await getRespondentByToken(req.params.token);
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
  const respondent = await getRespondentByToken(req.params.token);
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
  const respondent = await getRespondentByToken(req.params.token);
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
router.post("/:token/lock/exempt", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).json({ error: "Invalid link." });
  // Recorded as a dated, reasoned exemption rather than a permanent flag.
  //
  // In the Capacitor WebView browserSupportsWebAuthn() returns false, so every
  // respondent using the Android app was silently and permanently exempted on
  // first launch -- the device lock was effectively off for all app users, and
  // nothing said so. Stamping when and why means the exemption can be reviewed,
  // and re-checked once the app gains a native credential bridge.
  await store.update("respondents", { id: respondent.id }, {
    biometric_exempt: 1,
    biometric_exempt_at: store.nowSql(),
    biometric_exempt_reason: (req.body && req.body.reason) || "no_platform_authenticator",
  });
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
router.get("/:token/help", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  res.render("respondent/help", { respondent, content: require("../lib/helpContent").respondent });
});

// Applied to every respondent route below this point (registered after the
// /lock/* and /help routes above, so those always stay reachable regardless of lock state).
router.use("/:token", async (req, res, next) => {
  if (req.path === "/manifest.json" || req.path === "/help") return next(); // not sensitive
  const respondent = await getRespondentByToken(req.params.token);
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
  // Same skip as the /lock gate. Without it the two bounce off each other --
  // the gate sends the app to the diary, this sends it back to the gate.
  if (req.session.isNativeApp) return next();
  if (req.session.bioVerified && req.session.bioVerified[req.params.token]) return next();
  const next_ = encodeURIComponent(req.originalUrl);
  return res.redirect(`/r/${req.params.token}/lock?next=${next_}`);
});


/**
 * Everything the respondent tab screens need: their entries, with how much
 * evidence each carries and whether anything on it is still unconfirmed.
 *
 * Shared rather than repeated per route -- the three tabs are views of one set
 * of facts, and computing them separately is how "4 entries" on one tab and
 * "3 entries" on another creeps in.
 */
async function respondentOverview(respondent) {
  const records = await store.find("diary_records", { respondent_id: respondent.id }, { sort: { entry_time: -1 } });
  const ids = records.map((r) => r.id);
  const media = ids.length ? await store.find("media", { record_id: { $in: ids } }) : [];
  const responses = ids.length ? await store.find("responses", { record_id: { $in: ids } }) : [];
  const entries = records.map((r) => ({
    ...r,
    media_count: media.filter((m) => m.record_id === r.id).length,
    awaiting_check: responses.some((x) => x.record_id === r.id && x.source === "ai_video" && !x.verified),
  }));

  const submitted = entries.filter((e) => e.status === "submitted");
  const dayKey = (e) => String(e.occurrence_time || e.entry_time || "").slice(0, 10);
  const byMode = {};
  submitted.forEach((e) => { const k = e.entry_mode || "standard"; byMode[k] = (byMode[k] || 0) + 1; });

  // Fourteen dated buckets, including the empty ones. Charting only the days
  // with entries would compress gaps and make a patchy fortnight look steady.
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    daily.push({
      label: String(d.getDate()),
      count: submitted.filter((e) => dayKey(e) === key).length,
    });
  }

  return {
    entries,
    totals: {
      submitted: submitted.length,
      drafts: entries.filter((e) => e.status === "draft").length,
      activeDays: new Set(submitted.map(dayKey).filter(Boolean)).size,
      byMode,
    },
    daily,
  };
}

router.get("/:token/entries", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "This link is not valid.", user: null });
  const study = await store.findOne("studies", { id: respondent.study_id });
  const { entries } = await respondentOverview(respondent);
  res.render("respondent/entries", {
    respondent, study, entries,
    filter: req.query.status || "all",
    signedIn: req.session.respondentAccountId && req.session.respondentAccountId === respondent.account_id,
  });
});

router.get("/:token/activity", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "This link is not valid.", user: null });
  const study = await store.findOne("studies", { id: respondent.study_id });
  const { totals, daily } = await respondentOverview(respondent);
  res.render("respondent/activity", { respondent, study, totals, daily });
});

router.get("/:token/profile", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "This link is not valid.", user: null });
  const study = await store.findOne("studies", { id: respondent.study_id });
  res.render("respondent/profile", {
    respondent, study,
    signedIn: req.session.respondentAccountId && req.session.respondentAccountId === respondent.account_id,
  });
});

router.get("/:token", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "This link is not valid. Please contact your interviewer.", user: null });
  const study = await store.findOne("studies", { id: respondent.study_id });
  const consent = await store.findOne("consent_versions", { study_id: study.id, status: "approved" }, { sort: { version: -1 } });
  // entry_time is stored as 'YYYY-MM-DD HH:MM:SS', so sorting the string
  // descending is the same ordering datetime(entry_time) DESC gave.
  const records = await store.find("diary_records", { respondent_id: respondent.id }, { sort: { entry_time: -1 } });
  // Field-mode home needs three things the old stat-card layout did not:
  // whether anything is due today, how much evidence each entry carries (so a
  // stub can show a thumbnail), and whether any entry still has unconfirmed AI
  // answers. All computed here rather than in the view.
  const recordIds = records.map((r) => r.id);
  const allMedia = recordIds.length
    ? await store.find("media", { record_id: { $in: recordIds } })
    : [];
  const allResponses = recordIds.length
    ? await store.find("responses", { record_id: { $in: recordIds } })
    : [];
  const today = store.nowSql().slice(0, 10);
  const stubs = records.map((r) => {
    const mine = allMedia.filter((m) => m.record_id === r.id);
    return {
      ...r,
      media_type: (mine[0] || {}).media_type || null,
      media_count: mine.length,
      // An entry the AI answered that nobody has confirmed carries an amber
      // edge -- the respondent should see that it is still being checked
      // rather than believing it is finished and filed.
      awaiting_check: allResponses.some(
        (x) => x.record_id === r.id && x.source === "ai_video" && !x.verified
      ),
    };
  });
  const loggedToday = records.some(
    (r) => r.status === "submitted" && String(r.occurrence_time || "").slice(0, 10) === today
  );

  res.render("respondent/home", {
    respondent, study, consent, records,
    stubs, loggedToday,
    // Pre-existing gap: the post-submit redirect (see POST /:token/diary below)
    // has always appended ?saved=submitted|draft|screened_out, but this render
    // never forwarded it to the view, so home.ejs's confirmation banner never
    // actually appeared for anyone. Fixed here since the new "screened out"
    // banner depends on it too.
    saved: req.query.saved,
    pushEnabled: push.isEnabled(),
    vapidPublicKey: push.getPublicKey(),
    // Only offer "My studies" when the person is signed in as the very account
    // this enrolment belongs to. Deliberately not "has an account_id": the
    // token is in the URL, so anyone holding the link would otherwise get a
    // door into that person's other studies.
    signedIn:
      !!respondent.account_id && req.session.respondentAccountId === respondent.account_id,
  });
});

// ---- Diary reminder push notifications (Web Push / VAPID, see lib/push.js) ----
router.post("/:token/push/subscribe", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).json({ error: "Invalid link." });
  const ok = await push.saveSubscription(respondent.id, req.body, req.get("user-agent"));
  if (!ok) return res.status(400).json({ error: "Malformed subscription." });
  res.json({ subscribed: true });
});

router.post("/:token/push/unsubscribe", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).json({ error: "Invalid link." });
  if (req.body && req.body.endpoint) await push.removeSubscription(respondent.id, req.body.endpoint);
  res.json({ unsubscribed: true });
});

router.post("/:token/consent", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  await store.update("respondents", { id: respondent.id }, { consent_status: "given", activation_status: "activated" });
  res.redirect(`/r/${req.params.token}`);
});

router.get("/:token/diary/new", async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  const study = await store.findOne("studies", { id: respondent.study_id });
  const mode = req.query.mode;
  const practice = req.query.practice === "1";

  // No mode chosen yet — let the respondent pick how they want to log this entry.
  if (!mode) {
    return res.render("respondent/diary_mode_picker", { respondent, study, practice });
  }

  // Video mode has its own capture-first screen (see POST /diary/analyze-video below);
  // standard and audio modes go straight to the question form.
  if (mode === "video") {
    // The teleprompter script is derived from this study's own questionnaire,
    // so adding a question in the Builder puts it on screen with no extra
    // configuration -- and changing it to a numeric type takes it off, because
    // the extractor would never have filled it.
    const { questions: allQuestions } = await loadQuestionnaire(study.id);
    const script = buildVideoPrompts(allQuestions);
    return res.render("respondent/diary_video_capture", {
      respondent, study, practice,
      prompts: script.prompts,
      secondsEach: script.secondsEach,
      truncated: script.truncated,
      totalFillable: script.totalFillable,
    });
  }

  const { questions, rules } = await loadQuestionnaire(study.id);
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
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  const study = await store.findOne("studies", { id: respondent.study_id });
  const { questions, rules } = await loadQuestionnaire(study.id);
  const brands = await store.find("brands", { study_id: study.id, active: 1 }, { sort: { id: 1 } });
  const practice = req.body.practice === "1";

  if (!req.file) {
    // Re-rendering the capture screen has to rebuild the teleprompter too,
    // otherwise the retry shows a blank prompt list.
    const { questions: allQuestions } = await loadQuestionnaire(study.id);
    const script = buildVideoPrompts(allQuestions);
    return res.render("respondent/diary_video_capture", {
      respondent, study, practice, error: "Please record or choose a video before continuing.",
      prompts: script.prompts,
      secondsEach: script.secondsEach,
      truncated: script.truncated,
      totalFillable: script.totalFillable,
    });
  }

  // Submit ends the respondent's involvement. The entry is saved immediately
  // and the analysis runs behind them -- they no longer wait through frame
  // extraction, five Vision calls and a Speech call only to be handed a form
  // to fill in anyway.
  //
  // Everything the provider does can fail (misconfigured Azure, network blip,
  // corrupt upload). None of it may take the entry down with it: the video is
  // already saved as evidence, and a failed analysis just means no AI answers.
  const storedPath = await persistUpload(req.file).catch(() => `/uploads/${req.file.filename}`);
  const now = store.nowSql();

  const { id: recordId } = await store.insert("diary_records", {
    respondent_id: respondent.id,
    study_id: study.id,
    period_label: now.slice(0, 10),
    occurrence_time: now,
    submit_time: now,
    channel: "app",
    status: "submitted",
    is_practice: practice ? 1 : 0,
    entry_mode: "video",
  });
  const { id: mediaId } = await store.insert("media", {
    record_id: recordId,
    media_type: "video",
    file_path: storedPath,
  });

  // Fire-and-forget. The response below must not wait on it, and a rejection
  // here must never become an unhandled rejection that takes down the process
  // for every other respondent.
  analyzeSubmittedVideo({
    recordId,
    videoFile: req.file,
    questions,
    brands,
    studyVersion: study.version,
  }).catch((e) => console.warn(`Background video analysis failed for record ${recordId}: ${e.message}`));

  res.render("respondent/diary_video_done", { respondent, study, practice, recordId, mediaId });
});

// Stage a single media file while the respondent is still answering.
//
// A submit used to carry the answers AND every photo, video and voice note in
// one multipart request. With six media items in a questionnaire that is
// minutes of upload on mobile data with nothing visibly happening, which is
// why respondents pressed Submit repeatedly and logged the same occasion three
// times. Each file now uploads in the background the moment it is captured, so
// pressing Submit sends only the answers.
//
// The response returns an opaque id, never a file path. An earlier mechanism
// posted the server-side path back in a hidden field, which would let anyone
// attach an arbitrary file on the server to their own entry.
router.post("/:token/media/stage", upload.single("file"), async (req, res) => {
  const respondent = await store.findOne("respondents", { unique_token: req.params.token });
  if (!respondent) return res.status(404).json({ error: "Not found." });
  if (!req.file) return res.status(400).json({ error: "No file received." });

  const mime = req.file.mimetype || "";
  const mediaType = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "photo";
  const filePath = await persistUpload(req.file).catch(() => `/uploads/${req.file.filename}`);

  const { id } = await store.insert("staged_media", {
    respondent_id: respondent.id,
    question_id: req.body.question_id ? Number(req.body.question_id) : null,
    media_type: mediaType,
    file_path: filePath,
    created_at: store.nowSql(),
    consumed_at: null,
  });
  res.json({ staged_id: id, media_type: mediaType });
});

/**
 * Claim staged uploads for a submitted entry.
 *
 * Ownership is checked against the respondent rather than trusted from the
 * form, and a row already consumed is skipped -- otherwise a replayed submit
 * would attach the same file to two records.
 */
async function attachStagedMedia(recordId, respondentId, stagedIds) {
  const attached = [];
  for (const raw of stagedIds) {
    const id = Number(raw);
    if (!id) continue;
    const row = await store.findOne("staged_media", { id });
    if (!row || row.respondent_id !== respondentId || row.consumed_at) continue;
    const { id: mediaId } = await store.insert("media", {
      record_id: recordId,
      media_type: row.media_type,
      file_path: row.file_path,
    });
    await store.update("staged_media", { id }, { consumed_at: store.nowSql() });
    attached.push({ id: mediaId, record_id: recordId, media_type: row.media_type, file_path: row.file_path });
  }
  return attached;
}

router.post("/:token/diary", upload.any(), async (req, res) => {
  const respondent = await getRespondentByToken(req.params.token);
  if (!respondent) return res.status(404).render("error", { message: "Invalid link.", user: null });
  const study = await store.findOne("studies", { id: respondent.study_id });
  const isSubmit = req.body._action === "submit";
  const isPractice = req.body._practice === "1" ? 1 : 0;
  const entryMode = ["standard", "video", "audio"].includes(req.body._mode) ? req.body._mode : "standard";
  const occurrenceTime = req.body.occurrence_time ? req.body.occurrence_time.replace("T", " ") : new Date().toISOString().slice(0, 19).replace("T", " ");
  const periodLabel = req.body.period_label || occurrenceTime.slice(0, 10);

  const questions = await store.find("questions", { study_id: study.id, active: 1 }, { sort: { id: 1 } });

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
    // The old query was an INNER JOIN from skip_rules to questions purely to
    // pick up the condition question's text as `condition_text`; stitched here
    // in JS. INNER JOIN semantics are preserved deliberately: a rule whose
    // condition question no longer exists is dropped, not shown blank.
    const allRules = await store.find("skip_rules", { study_id: study.id }, { sort: { id: 1 } });
    const conditionQuestions = await store.find("questions", {
      id: { $in: allRules.map((r) => r.condition_question_id) },
    });
    const conditionById = new Map(conditionQuestions.map((q) => [q.id, q]));
    const rules = allRules
      .filter((r) => conditionById.has(r.condition_question_id))
      .map((r) => ({ ...r, condition_text: conditionById.get(r.condition_question_id).text }));
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

  // Enforce required answers and numeric ranges before anything is stored.
  // The form's own `required` attributes are a convenience for the respondent,
  // not a guarantee: a hidden control the browser can't validate, or a request
  // that never came from the form, would otherwise write an incomplete entry
  // that only shows up as a gap during analysis.
  //
  // Drafts are exempt on purpose -- see lib/answerValidation.js.
  if (isSubmit && !isTerminated) {
    const { rules: liveRules } = await loadQuestionnaire(study.id);
    const problems = validateSubmission({
      questions,
      rules: liveRules,
      body: req.body,
      files: req.files,
      pendingMediaPath: req.body._pending_media_path || null,
    });
    if (problems.length) {
      // Re-render with what they typed rather than sending them back to a
      // blank form. prefill is keyed by question code, matching the view.
      const prefill = {};
      questions.forEach((q) => {
        if (!q.code) return;
        const field = `q_${q.id}`;
        if (q.type === "multi") {
          const vals = req.body[field];
          if (vals) prefill[q.code] = (Array.isArray(vals) ? vals : [vals]).join("|");
        } else if (req.body[field] !== undefined && req.body[field] !== "") {
          prefill[q.code] = req.body[field];
        }
      });
      return res.status(400).render("respondent/diary_form", {
        respondent,
        study,
        questions,
        rules: liveRules,
        practice: !!isPractice,
        mode: entryMode === "audio" ? "audio" : "standard",
        prefill,
        pendingMedia: req.body._pending_media_path
          ? { path: req.body._pending_media_path, mimetype: req.body._pending_media_mimetype }
          : null,
        aiNote: null,
        problems,
      });
    }
  }

  const { id: recordId } = await store.insert("diary_records", {
    respondent_id: respondent.id,
    study_id: study.id,
    period_label: periodLabel,
    occurrence_time: occurrenceTime,
    submit_time: isSubmit ? new Date().toISOString().slice(0, 19).replace("T", " ") : null,
    channel: "app",
    status: isTerminated ? "screened_out" : (isSubmit ? "submitted" : "draft"),
    is_practice: isPractice,
    entry_mode: entryMode,
    terminate_note: terminateNote,
  });

  for (const q of questions) {
    const field = `q_${q.id}`;
    if (q.type === "multi") {
      const vals = req.body[field];
      if (vals) {
        const arr = Array.isArray(vals) ? vals : [vals];
        await store.insert("responses", { record_id: recordId, question_id: q.id, value: arr.join("|"), study_version: study.version });
      }
    } else if (q.type !== "photo" && q.type !== "video" && req.body[field] !== undefined && req.body[field] !== "") {
      await store.insert("responses", { record_id: recordId, question_id: q.id, value: req.body[field], study_version: study.version });
    }
  }

  const brands = await store.find("brands", { study_id: study.id, active: 1 }, { sort: { id: 1 } });

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
    const { id: mediaId } = await store.insert("media", { record_id: recordId, media_type: mediaType, file_path: req.body._pending_media_path });
    const mediaRow = { id: mediaId, record_id: recordId, media_type: mediaType, file_path: req.body._pending_media_path };
    if (brandProvider) brandProvider.detect(mediaRow, brands).catch(() => {});
  }

  // Media staged during the entry. These uploaded in the background as they
  // were captured, so there is nothing to transfer here -- only rows to claim.
  const stagedIds = [].concat(req.body._staged_media || []);
  const stagedRows = await attachStagedMedia(recordId, respondent.id, stagedIds);
  for (const mediaRow of stagedRows) {
    if (mediaRow.media_type === "audio") {
      if (audioProvider) audioProvider.transcribe(mediaRow).catch(() => {});
    } else if (brandProvider) {
      brandProvider.detect(mediaRow, brands).catch(() => {});
    }
  }

  // Anything not staged still arrives inline -- an older client, a browser
  // where the background upload failed, or JavaScript switched off. The slow
  // path has to keep working.
  for (const f of req.files || []) {
    // Hand each upload off to permanent storage (local disk or Azure Blob,
    // depending on STORAGE_PROVIDER) before recording its path — falls back
    // to the local "/uploads/..." path if storage isn't reachable so a
    // submission never fails outright over a storage hiccup.
    const storedPath = await persistUpload(f).catch(() => `/uploads/${f.filename}`);

    // Audio arrives either as the end-of-entry voice note (audio mode) or as the
    // answer to an "audio" question (fieldname audio_q_<id>). Both are stored as
    // audio media and transcribed; neither is a photo, so they must be caught
    // before the mimetype fallback below, which treats anything non-video as a
    // photo and would otherwise file a voice recording as an image.
    if (f.fieldname === "audio_note" || f.fieldname.startsWith("audio_q_") || (f.mimetype || "").startsWith("audio/")) {
      const { id: mediaId } = await store.insert("media", { record_id: recordId, media_type: "audio", file_path: storedPath });
      const mediaRow = { id: mediaId, record_id: recordId, media_type: "audio", file_path: storedPath };
      // Queue transcription — runs inline against the mock/Azure provider,
      // see lib/audioTranscription.js.
      if (audioProvider) audioProvider.transcribe(mediaRow).catch(() => {});
      continue;
    }
    const mediaType = (f.mimetype || "").startsWith("video/") ? "video" : "photo";
    const { id: mediaId } = await store.insert("media", { record_id: recordId, media_type: mediaType, file_path: storedPath });
    const mediaRow = { id: mediaId, record_id: recordId, media_type: mediaType, file_path: storedPath };
    // Queue brand detection for evidence that could show a product (photo or video).
    // Runs inline against the mock/Azure provider — see lib/brandDetection.js.
    if (brandProvider) brandProvider.detect(mediaRow, brands).catch(() => {});
  }

  if (isSubmit && !isPractice) {
    await store.update("respondents", { id: respondent.id, activation_status: { $ne: "active" } }, { activation_status: "active" });
    // A screened-out entry is a deliberately incomplete/disqualified response,
    // not a real diary submission -- it shouldn't trip QC flags for missing
    // fields/evidence, or count toward the cross-channel-duplicate check.
    if (!isTerminated) {
      await runQcForRecord(recordId);
      await checkCrossChannelDuplicate(respondent.id, periodLabel);
    }
  }

  // A study-scoped terminate rule ends the respondent's participation
  // entirely (see the "Scope" choice on the Skip Logic rule) — every route
  // under /r/:token now shows the end screen instead (see the router.use
  // gate above) until/unless a staff member changes their status by hand.
  if (isTerminated && terminateMatch.terminate_scope === "study" && !isPractice) {
    await store.update(
      "respondents",
      { id: respondent.id },
      { activation_status: "disqualified", disqualified_at: store.nowSql(), disqualify_reason: terminateNote }
    );
  }

  logAudit(respondent.respondent_code, isTerminated ? "diary_terminated" : (isSubmit ? "diary_submit" : "diary_draft"), "diary_records", recordId, { practice: !!isPractice, terminateScope: isTerminated ? terminateMatch.terminate_scope : undefined });

  res.redirect(`/r/${req.params.token}?saved=${isTerminated ? "screened_out" : (isSubmit ? "submitted" : "draft")}`);
});

module.exports = router;

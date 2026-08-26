// Seeds a clearly-marked SAMPLE pilot study so the app can be demoed end-to-end.
// Replace via the Developer/Config console (Studies > your study) with the real
// Day-1 inputs: questionnaire, brands/SKUs, consent wording, thresholds, KPIs.

const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { runQcForRecord } = require("./qc");
const { getProvider: getBrandDetectionProvider } = require("./brandDetection");
const { getProvider: getAudioTranscriptionProvider } = require("./audioTranscription");

function hoursAgo(h) {
  return new Date(Date.now() - h * 36e5).toISOString().slice(0, 19).replace("T", " ");
}

function wipe() {
  const tables = [
    "audit_log", "whatsapp_outbox", "reminders", "qc_flags", "media", "responses",
    "diary_records", "respondents", "kpi_config", "skip_rules", "question_imports", "questions",
    "consent_versions", "brands", "users", "studies",
  ];
  tables.forEach((t) => db.prepare(`DELETE FROM ${t}`).run());
}

function seed() {
  wipe();
  console.log("Seeding sample pilot study...");

  const studyInfo = db
    .prepare(
      `INSERT INTO studies (name, market, category, status, diary_mode, recruitment_mode,
        back_entry_hours, recall_window_hours, mandatory_photo, duplicate_similarity_threshold,
        burst_entry_count_threshold, burst_entry_window_hours, default_reminder_channel)
       VALUES (?, ?, ?, 'live', 'daily', 'hybrid', 24, 48, 1, 0.85, 3, 2, 'whatsapp')`
    )
    .run("Household Beverage Consumption Pilot (SAMPLE)", "Nigeria", "Beverages");
  const studyId = studyInfo.lastInsertRowid;

  // Users
  const hash = bcrypt.hashSync("Demo1234!", 10);
  const insertUser = db.prepare("INSERT INTO users (name, email, password_hash, role, study_id) VALUES (?, ?, ?, ?, ?)");
  insertUser.run("Admin User", "admin@inicio.demo", hash, "admin", null);
  const interviewer = insertUser.run("Interviewer One", "interviewer@inicio.demo", hash, "interviewer", null);
  insertUser.run("Client Stakeholder", "client@inicio.demo", hash, "client", studyId);
  const interviewerId = interviewer.lastInsertRowid;

  // Questionnaire
  const q = db.prepare(
    `INSERT INTO questions (study_id, order_index, code, type, text, required, options_json, min_value, max_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const occasionQ = q.run(studyId, 1, "occasion", "single", "What was the occasion for this consumption?", 1,
    JSON.stringify(["Breakfast", "Lunch", "Dinner", "Snack", "Social Gathering"]), null, null).lastInsertRowid;
  const brandQ = q.run(studyId, 2, "brand", "single", "Which brand did you consume?", 1,
    JSON.stringify(["Brand A", "Brand B", "Brand C", "Other"]), null, null).lastInsertRowid;
  const otherBrandQ = q.run(studyId, 3, "other_brand", "text", "Please specify the other brand", 0, null, null, null).lastInsertRowid;
  const locationQ = q.run(studyId, 4, "location", "single", "Where did you consume it?", 1,
    JSON.stringify(["Home", "Work", "Restaurant", "Outdoors"]), null, null).lastInsertRowid;
  const companionsQ = q.run(studyId, 5, "companions", "multi", "Who were you with?", 0,
    JSON.stringify(["Alone", "Family", "Friends", "Colleagues"]), null, null).lastInsertRowid;
  const quantityQ = q.run(studyId, 6, "quantity", "numeric", "How many servings did you have?", 1, null, 0, 10).lastInsertRowid;
  const reasonQ = q.run(studyId, 7, "reason", "text", "Why did you choose this brand/occasion?", 0, null, null, null).lastInsertRowid;
  const sourceQ = q.run(studyId, 8, "source", "single", "Where was it purchased/sourced from?", 1,
    JSON.stringify(["Retail Store", "Supermarket", "Online", "Already at home"]), null, null).lastInsertRowid;
  const photoQ = q.run(studyId, 9, "evidence", "photo", "Upload a photo of the product/meal", 1, null, null, null).lastInsertRowid;
  const videoQ = q.run(studyId, 10, "video_evidence", "video", "Optional: record a short video showing the product/brand", 0, null, null, null).lastInsertRowid;

  db.prepare(
    `INSERT INTO skip_rules (study_id, target_question_id, condition_question_id, operator, value, action)
     VALUES (?, ?, ?, 'equals', 'Other', 'show')`
  ).run(studyId, otherBrandQ, brandQ);

  // Brand / SKU master
  const b = db.prepare("INSERT INTO brands (study_id, name, category, sku) VALUES (?, ?, ?, ?)");
  b.run(studyId, "Brand A", "Beverages", "SKU-A100");
  b.run(studyId, "Brand B", "Beverages", "SKU-B200");
  b.run(studyId, "Brand C", "Beverages", "SKU-C300");

  // Consent — approved
  db.prepare(
    `INSERT INTO consent_versions (study_id, version, body, status, approved_by, approved_at)
     VALUES (?, 1, ?, 'approved', 'Research Lead', datetime('now'))`
  ).run(
    studyId,
    "SAMPLE WORDING — replace with your approved ethics/legal consent text. I agree to take part in this in-home consumption diary study. My responses and any photos I submit will be used for research purposes only and handled in line with the study's privacy notice. I can withdraw at any time by contacting my interviewer."
  );

  // KPI config
  const kpiDefaults = [
    ["completion_rate", "Diary Completion Rate"],
    ["compliance_rate", "Compliance Rate"],
    ["brand_incidence", "Brand Incidence"],
    ["avg_occasions_per_week", "Avg Occasions / Week"],
    ["qc_flag_rate", "QC Flag Rate"],
    ["active_respondents", "Active Respondents"],
  ];
  const insertKpi = db.prepare("INSERT INTO kpi_config (study_id, kpi_key, label, enabled) VALUES (?, ?, ?, 1)");
  kpiDefaults.forEach(([k, l]) => insertKpi.run(studyId, k, l));

  // Respondents across the funnel
  const insertResp = db.prepare(
    `INSERT INTO respondents (study_id, respondent_code, name, contact, recruitment_mode, preferred_channel,
      consent_status, activation_status, unique_token, interviewer_id, is_practice)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  function mkRespondent(idx, name, mode, channel, status, consent, practice = 0) {
    const code = `R01-${String(idx).padStart(4, "0")}`;
    const info = insertResp.run(studyId, code, name, `+234700000${1000 + idx}`, mode, channel, consent, status, uuidv4(), mode === "f2f" ? interviewerId : null, practice);
    return { id: info.lastInsertRowid, code };
  }

  const funnelOnly = [
    mkRespondent(1, "Amaka Obi", "remote", "app", "invited", "pending"),
    mkRespondent(2, "Tunde Bakare", "remote", "app", "invited", "pending"),
    mkRespondent(3, "Ngozi Eze", "f2f", "app", "screened", "pending"),
    mkRespondent(4, "Chidi Nwosu", "f2f", "app", "registered", "given"),
  ];

  const active = [
    mkRespondent(5, "Blessing Adeyemi", "f2f", "app", "active", "given"),
    mkRespondent(6, "Emeka Chukwu", "f2f", "whatsapp", "active", "given"),
    mkRespondent(7, "Funmi Alabi", "remote", "app", "active", "given"),
    mkRespondent(8, "Ibrahim Musa", "remote", "app", "active", "given"),
    mkRespondent(9, "Grace Etim", "remote", "whatsapp", "active", "given"),
  ];
  const draftOnly = mkRespondent(10, "Segun Ojo", "remote", "app", "activated", "given");
  const practiceResp = mkRespondent(11, "Practice Tester", "f2f", "app", "activated", "given", 1);

  // Helper to submit a clean diary record
  function submitRecord(resp, brand, occasion, quantity, hoursAgoOccurrence, hoursAgoEntry, withPhoto = true, practice = 0, entryMode = "standard") {
    const occ = hoursAgo(hoursAgoOccurrence);
    const ent = hoursAgo(hoursAgoEntry);
    const period = occ.slice(0, 10);
    const info = db
      .prepare(
        `INSERT INTO diary_records (respondent_id, study_id, period_label, occurrence_time, entry_time, submit_time, channel, status, is_practice, entry_mode)
         VALUES (?, ?, ?, ?, ?, ?, 'app', 'submitted', ?, ?)`
      )
      .run(resp.id, studyId, period, occ, ent, ent, practice, entryMode);
    const recordId = info.lastInsertRowid;
    const insertR = db.prepare("INSERT INTO responses (record_id, question_id, value, study_version) VALUES (?, ?, ?, 1)");
    insertR.run(recordId, occasionQ, occasion);
    insertR.run(recordId, brandQ, brand);
    insertR.run(recordId, locationQ, "Home");
    insertR.run(recordId, companionsQ, "Family");
    insertR.run(recordId, quantityQ, String(quantity));
    insertR.run(recordId, reasonQ, "Usual choice for the household");
    insertR.run(recordId, sourceQ, "Supermarket");
    if (withPhoto) {
      db.prepare("INSERT INTO media (record_id, media_type, file_path) VALUES (?, 'photo', '/uploads/sample-placeholder.jpg')").run(recordId);
    }
    return recordId;
  }

  // Clean records
  const firstRecordId = submitRecord(active[0], "Brand A", "Breakfast", 1, 20, 19, true, 0, "video");
  submitRecord(active[0], "Brand B", "Snack", 1, 44, 43);
  const audioRecordId = submitRecord(active[1], "Brand A", "Dinner", 2, 18, 17, true, 0, "audio");
  submitRecord(active[2], "Brand C", "Lunch", 1, 22, 21);
  submitRecord(active[2], "Brand C", "Social Gathering", 2, 46, 45);

  // Late back-entry breach (occurrence 60h ago, entered now -> gap 60h > 24h window)
  submitRecord(active[3], "Brand B", "Dinner", 1, 60, 0);

  // Missing photo evidence
  submitRecord(active[4], "Brand A", "Lunch", 1, 5, 4, false);

  // Duplicate/repetitive: two near-identical submissions close together
  const r1 = submitRecord(active[3], "Brand B", "Dinner", 1, 10, 9);
  runQcForRecord(r1);
  const r2 = submitRecord(active[3], "Brand B", "Dinner", 1, 8, 7);
  runQcForRecord(r2);

  // Range/logic breach: quantity above max (10)
  const rangeRecordId = (() => {
    const occ = hoursAgo(3);
    const ent = hoursAgo(2);
    const info = db
      .prepare(
        `INSERT INTO diary_records (respondent_id, study_id, period_label, occurrence_time, entry_time, submit_time, channel, status)
         VALUES (?, ?, ?, ?, ?, ?, 'app', 'submitted')`
      )
      .run(active[4].id, studyId, occ.slice(0, 10), occ, ent, ent);
    const recordId = info.lastInsertRowid;
    const insertR = db.prepare("INSERT INTO responses (record_id, question_id, value, study_version) VALUES (?, ?, ?, 1)");
    insertR.run(recordId, occasionQ, "Snack");
    insertR.run(recordId, brandQ, "Brand C");
    insertR.run(recordId, locationQ, "Work");
    insertR.run(recordId, quantityQ, "18"); // over max of 10
    insertR.run(recordId, sourceQ, "Retail Store");
    db.prepare("INSERT INTO media (record_id, media_type, file_path) VALUES (?, 'photo', '/uploads/sample-placeholder.jpg')").run(recordId);
    return recordId;
  })();

  // Burst entries for respondent active[2]: 4 submissions inside 2h window
  let burstRecordId;
  for (let i = 0; i < 4; i++) {
    burstRecordId = submitRecord(active[2], "Brand C", "Snack", 1, 1, 1 - i * 0.2, true);
  }

  // Run QC engine over every submitted, non-practice record (mirrors what happens live on submit)
  const allSubmitted = db.prepare("SELECT id FROM diary_records WHERE status='submitted' AND is_practice = 0").all();
  allSubmitted.forEach((r) => runQcForRecord(r.id));

  // One draft (incomplete) diary for funnel/compliance visibility
  db.prepare(
    `INSERT INTO diary_records (respondent_id, study_id, period_label, occurrence_time, entry_time, channel, status)
     VALUES (?, ?, ?, ?, ?, 'app', 'draft')`
  ).run(draftOnly.id, studyId, hoursAgo(2).slice(0, 10), hoursAgo(2), hoursAgo(2));

  // Practice entry — excluded from production analysis
  submitRecord(practiceResp, "Brand A", "Breakfast", 1, 2, 1, true, 1);

  // Sample video evidence + a brand-detection run, so Media Review has something to show
  const videoMediaInfo = db
    .prepare("INSERT INTO media (record_id, media_type, file_path) VALUES (?, 'video', '/uploads/sample-placeholder.jpg')")
    .run(firstRecordId);
  const seededBrands = db.prepare("SELECT * FROM brands WHERE study_id = ?").all(studyId);
  getBrandDetectionProvider().detect({ id: videoMediaInfo.lastInsertRowid }, seededBrands);

  // Sample voice note + a transcription run, so Media Review demonstrates the audio-mode wiring too
  const audioMediaInfo = db
    .prepare("INSERT INTO media (record_id, media_type, file_path) VALUES (?, 'audio', '/uploads/sample-placeholder.jpg')")
    .run(audioRecordId);
  getAudioTranscriptionProvider().transcribe({ id: audioMediaInfo.lastInsertRowid });

  console.log("Seed complete.");
  console.log("Study ID:", studyId);
  console.log("Sample respondent diary links:");
  [...active, draftOnly].forEach((r) => {
    const full = db.prepare("SELECT unique_token, respondent_code FROM respondents WHERE id = ?").get(r.id);
    console.log(`  ${full.respondent_code}: /r/${full.unique_token}`);
  });
}

seed();

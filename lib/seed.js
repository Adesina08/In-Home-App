// Seeds a clearly-marked SAMPLE pilot study so the app can be demoed end-to-end.
// Replace via the Developer/Config console (Studies > your study) with the real
// Day-1 inputs: questionnaire, brands/SKUs, consent wording, thresholds, KPIs.

const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const store = require("./store");
const { runQcForRecord } = require("./qc");
const { getProvider: getBrandDetectionProvider } = require("./brandDetection");
const { getProvider: getAudioTranscriptionProvider } = require("./audioTranscription");

function hoursAgo(h) {
  return new Date(Date.now() - h * 36e5).toISOString().slice(0, 19).replace("T", " ");
}

async function wipe() {
  // Every collection, plus the id counters -- otherwise a re-seed starts
  // allocating ids well above 1 and the "study 1" the docs and demo links
  // refer to no longer exists.
  const collections = [
    "audit_log", "whatsapp_outbox", "reminders", "qc_flags", "media", "responses",
    "diary_records", "respondents", "kpi_config", "skip_rules", "question_imports", "questions",
    "consent_versions", "brands", "users", "studies",
    "respondent_credentials", "push_subscriptions", "ai_summaries", "respondent_accounts", "otp_codes",
    "counters",
  ];
  for (const c of collections) await store.clear(c);
}

async function seed() {
  await store.connect();
  await wipe();
  console.log("Seeding sample pilot study...");

  const { id: studyId } = await store.insert("studies", {
    name: "Household Beverage Consumption Pilot (SAMPLE)",
    market: "Nigeria",
    category: "Beverages",
    status: "live",
    diary_mode: "daily",
    recruitment_mode: "hybrid",
    back_entry_hours: 24,
    recall_window_hours: 48,
    mandatory_photo: 1,
    duplicate_similarity_threshold: 0.85,
    burst_entry_count_threshold: 3,
    burst_entry_window_hours: 2,
    default_reminder_channel: "whatsapp",
  });

  // Users
  const hash = bcrypt.hashSync("Demo1234!", 10);
  const insertUser = (name, email, role, study_id) =>
    store.insert("users", { name, email, password_hash: hash, role, study_id });
  await insertUser("Admin User", "admin@inicio.demo", "admin", null);
  const interviewer = await insertUser("Interviewer One", "interviewer@inicio.demo", "interviewer", null);
  await insertUser("Client Stakeholder", "client@inicio.demo", "client", studyId);
  const interviewerId = interviewer.id;

  // Questionnaire
  const q = async (study_id, order_index, code, type, text, required, options_json, min_value, max_value) =>
    (await store.insert("questions", {
      study_id, order_index, code, type, text, required, options_json, min_value, max_value,
    })).id;
  const occasionQ = await q(studyId, 1, "occasion", "single", "What was the occasion for this consumption?", 1,
    JSON.stringify(["Breakfast", "Lunch", "Dinner", "Snack", "Social Gathering"]), null, null);
  const brandQ = await q(studyId, 2, "brand", "single", "Which brand did you consume?", 1,
    JSON.stringify(["Brand A", "Brand B", "Brand C", "Other"]), null, null);
  const otherBrandQ = await q(studyId, 3, "other_brand", "text", "Please specify the other brand", 0, null, null, null);
  const locationQ = await q(studyId, 4, "location", "single", "Where did you consume it?", 1,
    JSON.stringify(["Home", "Work", "Restaurant", "Outdoors"]), null, null);
  const companionsQ = await q(studyId, 5, "companions", "multi", "Who were you with?", 0,
    JSON.stringify(["Alone", "Family", "Friends", "Colleagues"]), null, null);
  const quantityQ = await q(studyId, 6, "quantity", "numeric", "How many servings did you have?", 1, null, 0, 10);
  const reasonQ = await q(studyId, 7, "reason", "text", "Why did you choose this brand/occasion?", 0, null, null, null);
  const sourceQ = await q(studyId, 8, "source", "single", "Where was it purchased/sourced from?", 1,
    JSON.stringify(["Retail Store", "Supermarket", "Online", "Already at home"]), null, null);
  const photoQ = await q(studyId, 9, "evidence", "photo", "Upload a photo of the product/meal", 1, null, null, null);
  const videoQ = await q(studyId, 10, "video_evidence", "video", "Optional: record a short video showing the product/brand", 0, null, null, null);

  await store.insert("skip_rules", {
    study_id: studyId,
    target_question_id: otherBrandQ,
    condition_question_id: brandQ,
    operator: "equals",
    value: "Other",
    action: "show",
  });

  // Brand / SKU master
  const b = (name, category, sku) => store.insert("brands", { study_id: studyId, name, category, sku });
  await b("Brand A", "Beverages", "SKU-A100");
  await b("Brand B", "Beverages", "SKU-B200");
  await b("Brand C", "Beverages", "SKU-C300");

  // Consent — approved
  await store.insert("consent_versions", {
    study_id: studyId,
    version: 1,
    status: "approved",
    approved_by: "Research Lead",
    approved_at: store.nowSql(),
    body:
    "SAMPLE WORDING — replace with your approved ethics/legal consent text. I agree to take part in this in-home consumption diary study. My responses and any photos I submit will be used for research purposes only and handled in line with the study's privacy notice. I can withdraw at any time by contacting my interviewer.",
  });

  // KPI config
  const kpiDefaults = [
    ["completion_rate", "Diary Completion Rate"],
    ["compliance_rate", "Compliance Rate"],
    ["brand_incidence", "Brand Incidence"],
    ["avg_occasions_per_week", "Avg Occasions / Week"],
    ["qc_flag_rate", "QC Flag Rate"],
    ["active_respondents", "Active Respondents"],
  ];
  for (const [k, l] of kpiDefaults) {
    await store.insert("kpi_config", { study_id: studyId, kpi_key: k, label: l, enabled: 1 });
  }

  // Respondents across the funnel
  async function mkRespondent(idx, name, mode, channel, status, consent, practice = 0) {
    const code = `R01-${String(idx).padStart(4, "0")}`;
    const { id } = await store.insert("respondents", {
      study_id: studyId,
      respondent_code: code,
      name,
      contact: `+234700000${1000 + idx}`,
      recruitment_mode: mode,
      preferred_channel: channel,
      consent_status: consent,
      activation_status: status,
      unique_token: uuidv4(),
      interviewer_id: mode === "f2f" ? interviewerId : null,
      is_practice: practice,
    });
    return { id, code };
  }

  const funnelOnly = [
    await mkRespondent(1, "Amaka Obi", "remote", "app", "invited", "pending"),
    await mkRespondent(2, "Tunde Bakare", "remote", "app", "invited", "pending"),
    await mkRespondent(3, "Ngozi Eze", "f2f", "app", "screened", "pending"),
    await mkRespondent(4, "Chidi Nwosu", "f2f", "app", "registered", "given"),
  ];

  const active = [
    await mkRespondent(5, "Blessing Adeyemi", "f2f", "app", "active", "given"),
    await mkRespondent(6, "Emeka Chukwu", "f2f", "whatsapp", "active", "given"),
    await mkRespondent(7, "Funmi Alabi", "remote", "app", "active", "given"),
    await mkRespondent(8, "Ibrahim Musa", "remote", "app", "active", "given"),
    await mkRespondent(9, "Grace Etim", "remote", "whatsapp", "active", "given"),
  ];
  const draftOnly = await mkRespondent(10, "Segun Ojo", "remote", "app", "activated", "given");
  const practiceResp = await mkRespondent(11, "Practice Tester", "f2f", "app", "activated", "given", 1);

  // Helper to submit a clean diary record
  const insertR = (record_id, question_id, value) =>
    store.insert("responses", { record_id, question_id, value, study_version: 1 });

  async function submitRecord(resp, brand, occasion, quantity, hoursAgoOccurrence, hoursAgoEntry, withPhoto = true, practice = 0, entryMode = "standard") {
    const occ = hoursAgo(hoursAgoOccurrence);
    const ent = hoursAgo(hoursAgoEntry);
    const period = occ.slice(0, 10);
    const { id: recordId } = await store.insert("diary_records", {
      respondent_id: resp.id,
      study_id: studyId,
      period_label: period,
      occurrence_time: occ,
      entry_time: ent,
      submit_time: ent,
      channel: "app",
      status: "submitted",
      is_practice: practice,
      entry_mode: entryMode,
    });
    await insertR(recordId, occasionQ, occasion);
    await insertR(recordId, brandQ, brand);
    await insertR(recordId, locationQ, "Home");
    await insertR(recordId, companionsQ, "Family");
    await insertR(recordId, quantityQ, String(quantity));
    await insertR(recordId, reasonQ, "Usual choice for the household");
    await insertR(recordId, sourceQ, "Supermarket");
    if (withPhoto) {
      await store.insert("media", { record_id: recordId, media_type: "photo", file_path: "/uploads/sample-placeholder.jpg" });
    }
    return recordId;
  }

  // Clean records
  const firstRecordId = await submitRecord(active[0], "Brand A", "Breakfast", 1, 20, 19, true, 0, "video");
  await submitRecord(active[0], "Brand B", "Snack", 1, 44, 43);
  const audioRecordId = await submitRecord(active[1], "Brand A", "Dinner", 2, 18, 17, true, 0, "audio");
  await submitRecord(active[2], "Brand C", "Lunch", 1, 22, 21);
  await submitRecord(active[2], "Brand C", "Social Gathering", 2, 46, 45);

  // Late back-entry breach (occurrence 60h ago, entered now -> gap 60h > 24h window)
  await submitRecord(active[3], "Brand B", "Dinner", 1, 60, 0);

  // Missing photo evidence
  await submitRecord(active[4], "Brand A", "Lunch", 1, 5, 4, false);

  // Duplicate/repetitive: two near-identical submissions close together
  const r1 = await submitRecord(active[3], "Brand B", "Dinner", 1, 10, 9);
  await runQcForRecord(r1);
  const r2 = await submitRecord(active[3], "Brand B", "Dinner", 1, 8, 7);
  await runQcForRecord(r2);

  // Range/logic breach: quantity above max (10)
  const rangeRecordId = await (async () => {
    const occ = hoursAgo(3);
    const ent = hoursAgo(2);
    const { id: recordId } = await store.insert("diary_records", {
      respondent_id: active[4].id,
      study_id: studyId,
      period_label: occ.slice(0, 10),
      occurrence_time: occ,
      entry_time: ent,
      submit_time: ent,
      channel: "app",
      status: "submitted",
    });
    await insertR(recordId, occasionQ, "Snack");
    await insertR(recordId, brandQ, "Brand C");
    await insertR(recordId, locationQ, "Work");
    await insertR(recordId, quantityQ, "18"); // over max of 10
    await insertR(recordId, sourceQ, "Retail Store");
    await store.insert("media", { record_id: recordId, media_type: "photo", file_path: "/uploads/sample-placeholder.jpg" });
    return recordId;
  })();

  // Burst entries for respondent active[2]: 4 submissions inside 2h window
  let burstRecordId;
  for (let i = 0; i < 4; i++) {
    burstRecordId = await submitRecord(active[2], "Brand C", "Snack", 1, 1, 1 - i * 0.2, true);
  }

  // Run QC engine over every submitted, non-practice record (mirrors what happens live on submit)
  const allSubmitted = await store.find("diary_records", { status: "submitted", is_practice: 0 }, { sort: { id: 1 }, projection: { id: 1 } });
  for (const r of allSubmitted) await runQcForRecord(r.id);

  // One draft (incomplete) diary for funnel/compliance visibility
  await store.insert("diary_records", {
    respondent_id: draftOnly.id,
    study_id: studyId,
    period_label: hoursAgo(2).slice(0, 10),
    occurrence_time: hoursAgo(2),
    entry_time: hoursAgo(2),
    channel: "app",
    status: "draft",
  });

  // Practice entry — excluded from production analysis
  await submitRecord(practiceResp, "Brand A", "Breakfast", 1, 2, 1, true, 1);

  // Sample video evidence + a brand-detection run, so Media Review has something to show
  const videoMedia = await store.insert("media", { record_id: firstRecordId, media_type: "video", file_path: "/uploads/sample-placeholder.jpg" });
  const seededBrands = await store.find("brands", { study_id: studyId }, { sort: { id: 1 } });
  // Awaited now: the detection write is a database round trip, and the seed
  // would otherwise finish and close the connection underneath it.
  await getBrandDetectionProvider().detect({ id: videoMedia.id }, seededBrands);

  // Sample voice note + a transcription run, so Media Review demonstrates the audio-mode wiring too
  const audioMedia = await store.insert("media", { record_id: audioRecordId, media_type: "audio", file_path: "/uploads/sample-placeholder.jpg" });
  await getAudioTranscriptionProvider().transcribe({ id: audioMedia.id });

  console.log("Seed complete.");
  console.log("Study ID:", studyId);
  console.log("Sample respondent diary links:");
  for (const r of [...active, draftOnly]) {
    const full = await store.findOne("respondents", { id: r.id });
    console.log(`  ${full.respondent_code}: /r/${full.unique_token}`);
  }

  await store.close();
}

seed().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});

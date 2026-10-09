// AI mapping of a study's own questions onto its recipe KPIs, plus the
// researcher review around it (framework sections 10.3 and 13).
//
// The AI reads the questionnaire and proposes, per KPI input, which question
// (and which of its options) measures it. Every proposal is validated against
// the real questionnaire -- an id that isn't an active question, a question of
// the wrong type, or an option the question doesn't have is dropped, never
// repaired by guesswork. Proposals stay "proposed" until a researcher approves
// them; only approved mappings reach a dashboard. Approved mappings survive a
// re-run untouched unless a question they rely on is removed.
//
// kpi_mappings rows: { study_id, kpi_key, inputs_json, status: proposed |
// approved | rejected | unmapped, source: ai | manual, confidence, reason,
// proposed_at, reviewed_by, reviewed_at }.

const store = require("./store");
const { logAudit } = require("./audit");
const { parseOptions } = require("./questionnaire");
const { recipeKpis, studyTypeOf, recipeFor, STUDY_TYPES, CHOICE, NUMBER } = require("./studyRecipes");
const recipe = require("./recipeKpis");

const MAPPABLE_TYPES = new Set([...CHOICE, ...NUMBER, "time"]);
const DEBOUNCE_MS = 20000;

// ---------- Provider ----------

// KPI_MAPPING_PROVIDER picks openai or gemini. Unset, it follows the AI
// summary provider, falling back to whichever of the two has a key -- a
// missing key on one should not leave mapping dead when the other works.
function provider() {
  const keys = { openai: !!process.env.OPENAI_API_KEY?.trim(), gemini: !!process.env.GEMINI_API_KEY?.trim() };
  const chosen = String(process.env.KPI_MAPPING_PROVIDER || "").trim().toLowerCase();
  const preferred = chosen || (process.env.AI_SUMMARY_PROVIDER === "gemini" ? "gemini" : "openai");
  const name = keys[preferred] ? preferred : !chosen && keys.openai ? "openai" : !chosen && keys.gemini ? "gemini" : null;
  if (!name) return null;
  if (name === "gemini") {
    const gemini = require("./geminiClient");
    return {
      name,
      complete: ({ system, prompt }) => gemini.generateText({
        apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || gemini.DEFAULT_MODEL,
        systemInstruction: system, prompt, temperature: 0, maxOutputTokens: 6000, timeoutMs: 90000,
      }),
    };
  }
  const openai = require("./openaiClient");
  return {
    name,
    complete: ({ system, prompt }) => openai.generateText({
      model: process.env.OPENAI_KPI_MODEL?.trim() || openai.configuredModel(),
      system, prompt, maxTokens: 6000, timeoutMs: 90000, json: true, label: "KPI mapping",
    }),
  };
}

// ---------- Questions ----------

/** Active questions a KPI can read, one per family (loop repeats share a code). */
async function candidateQuestions(studyId) {
  const all = await store.find("questions", { study_id: studyId, active: 1 }, { sort: { order_index: 1, id: 1 } });
  const seen = new Set();
  const out = [];
  for (const q of all) {
    if (!MAPPABLE_TYPES.has(q.type)) continue;
    const family = q.source_code || q.code || `#${q.id}`;
    if (seen.has(family)) continue;
    seen.add(family);
    out.push({ id: q.id, code: q.code || null, text: String(q.text || ""), type: q.type, section: q.section || null, options: parseOptions(q.options_json) });
  }
  return out;
}

// ---------- Prompt and validation ----------

const SYSTEM_PROMPT = [
  "You map a market-research diary questionnaire onto reporting KPIs.",
  "For every input of every KPI, choose the ONE question from the list that measures what the input describes, or null when no question does.",
  "Rules:",
  "- Use only question ids from the list, and only a question whose type is in the input's `accepts` list.",
  "- When an input has `options`, return the exact option strings of the chosen question that match the description. `required` means a choice question must have at least one option chosen. For numeric questions return an empty options list.",
  "- Never invent questions or options. Prefer null over a weak match; a missing KPI is better than a wrong one.",
  "- The same question may serve several KPIs (e.g. the brand question).",
  'Respond with ONLY strict JSON: {"mappings": [{"kpi": "<kpi key>", "inputs": {"<role>": {"question_id": <id or null>, "options": ["<option>", ...]}}, "confidence": <0 to 1>, "reason": "<one short sentence naming the question(s) used>"}]}',
].join("\n");

// OpenAI's JSON mode refuses a request whose input never says "json", so the
// payload is introduced in words rather than sent bare.
function buildPrompt(study, kpis, questions) {
  return "Map these KPIs onto these questionnaire questions and answer in JSON.\n" + JSON.stringify({
    study: { name: study.name || "", type: STUDY_TYPES[studyTypeOf(study)].label, categories: study.category || "" },
    kpis: kpis.map((kpi) => ({
      kpi: kpi.key, label: kpi.label, definition: kpi.definition,
      inputs: kpi.inputs.map((i) => ({ role: i.role, describe: i.describe, accepts: i.accepts, ...(i.options ? { options: i.options } : {}), ...(i.optional ? { optional: true } : {}) })),
    })),
    questions: questions.slice(0, 250).map((q) => ({
      id: q.id, code: q.code, text: q.text.slice(0, 240), type: q.type,
      ...(q.section ? { section: q.section } : {}), ...(q.options.length ? { options: q.options.slice(0, 60) } : {}),
    })),
  });
}

function parseReply(text) {
  const clean = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(clean);
  return Array.isArray(parsed.mappings) ? parsed.mappings : [];
}

/**
 * Keep only what the questionnaire can actually support. Returns
 * { inputs, complete } -- `complete` when every required input survived.
 */
function validateInputs(kpi, proposed, questionsById) {
  const inputs = {};
  for (const spec of kpi.inputs) {
    const raw = proposed && proposed[spec.role];
    const question = raw && questionsById.get(Number(raw.question_id));
    if (!question || !spec.accepts.includes(question.type)) continue;
    let options = [];
    if (spec.options && CHOICE.includes(question.type)) {
      const byLower = new Map(question.options.map((o) => [String(o).toLowerCase(), o]));
      options = [...new Set([].concat(raw.options || []).map((o) => byLower.get(String(o).trim().toLowerCase())).filter(Boolean))];
      if (spec.options === "required" && !options.length) continue;
    }
    inputs[spec.role] = { question_id: question.id, options };
  }
  const complete = kpi.inputs.filter((i) => !i.optional).every((i) => inputs[i.role]);
  return { inputs, complete };
}

// ---------- Storage ----------

function parseRow(row) {
  if (!row) return null;
  let inputs = {};
  try { inputs = JSON.parse(row.inputs_json || "{}") || {}; } catch (_) {}
  return { ...row, inputs };
}

async function loadMappings(studyId) {
  const rows = await store.find("kpi_mappings", { study_id: studyId });
  return new Map(rows.map((r) => [r.kpi_key, parseRow(r)]));
}

async function saveMapping(studyId, kpiKey, fields) {
  const existing = await store.findOne("kpi_mappings", { study_id: studyId, kpi_key: kpiKey });
  const row = { ...fields, ...(fields.inputs ? { inputs_json: JSON.stringify(fields.inputs) } : {}) };
  delete row.inputs;
  if (existing) await store.update("kpi_mappings", { id: existing.id }, row);
  else await store.insert("kpi_mappings", { study_id: studyId, kpi_key: kpiKey, ...row });
}

/** An approved mapping whose questions are all still active and of an accepted type. */
function stillValid(kpi, mapping, questionsById) {
  return kpi.inputs.every((spec) => {
    const used = mapping.inputs[spec.role];
    if (!used) return !!spec.optional;
    const q = questionsById.get(Number(used.question_id));
    return q && spec.accepts.includes(q.type);
  });
}

// ---------- Running ----------

const running = new Set();
const timers = new Map();

/**
 * Ask the AI for a fresh set of proposals. Approved mappings that still
 * point at live questions are left alone; everything else is replaced.
 */
function runMapping(studyId, options = {}) {
  // Marked synchronously, so a page loaded the instant after "Re-map" sees it.
  if (running.has(studyId)) return Promise.resolve({ status: "running" });
  running.add(studyId);
  return mapNow(studyId, options).finally(() => running.delete(studyId));
}

/** True while a run is waiting on its debounce timer or in progress in this process. */
function isPending(studyId) {
  return running.has(studyId) || timers.has(studyId);
}

async function mapNow(studyId, { actor = "system" } = {}) {
  const study = await store.findOne("studies", { id: studyId });
  if (!study || !studyTypeOf(study)) return { status: "skipped" };
  const ai = provider();
  if (!ai) {
    await store.update("studies", { id: studyId }, { kpi_mapping_status: "unconfigured", kpi_mapping_error: "No AI provider is configured. Set OPENAI_API_KEY or GEMINI_API_KEY, or map each KPI by hand." });
    return { status: "unconfigured" };
  }
  await store.update("studies", { id: studyId }, { kpi_mapping_status: "running", kpi_mapping_error: null });
  try {
    const questions = await candidateQuestions(studyId);
    const questionsById = new Map(questions.map((q) => [q.id, q]));
    const existing = await loadMappings(studyId);
    const mappable = recipeKpis(study).filter((kpi) => kpi.inputs.length)
      .filter((kpi, i, list) => list.findIndex((other) => other.key === kpi.key) === i);
    const keep = (kpi) => { const row = existing.get(kpi.key); return row && row.status === "approved" && stillValid(kpi, row, questionsById); };
    const toMap = mappable.filter((kpi) => !keep(kpi));

    let proposals = [];
    if (toMap.length && questions.length) {
      proposals = parseReply(await ai.complete({ system: SYSTEM_PROMPT, prompt: buildPrompt(study, toMap, questions) }));
    }
    const byKey = new Map(proposals.filter((p) => p && p.kpi).map((p) => [String(p.kpi), p]));
    const now = store.nowSql();
    for (const kpi of toMap) {
      const proposal = byKey.get(kpi.key);
      const { inputs } = validateInputs(kpi, proposal && proposal.inputs, questionsById);
      const anything = Object.keys(inputs).length > 0;
      // A researcher's rejection stands until the AI suggests something different.
      const before = existing.get(kpi.key);
      if (before && before.status === "rejected" && JSON.stringify(before.inputs) === JSON.stringify(inputs)) continue;
      const confidence = Number(proposal && proposal.confidence);
      await saveMapping(studyId, kpi.key, {
        inputs, status: anything ? "proposed" : "unmapped", source: "ai",
        confidence: anything && Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
        reason: anything ? String(proposal.reason || "").slice(0, 300) : "No question in this questionnaire measures this.",
        proposed_at: now, reviewed_by: null, reviewed_at: null,
      });
    }
    await store.update("studies", { id: studyId }, { kpi_mapping_status: "done", kpi_mapped_at: now, kpi_mapping_provider: ai.name, kpi_mapping_error: null });
    logAudit(actor, "kpi_mapping_run", "studies", studyId, { provider: ai.name, mapped: toMap.length, kept: mappable.length - toMap.length });
    return { status: "done", mapped: toMap.length };
  } catch (e) {
    await store.update("studies", { id: studyId }, { kpi_mapping_status: "error", kpi_mapping_error: String(e.message || e).slice(0, 300) });
    return { status: "error", error: e.message };
  }
}

/**
 * Re-map shortly after the questionnaire stops changing. Debounced so a
 * researcher typing through twenty questions triggers one AI call, not
 * twenty. Best-effort: the "Re-map with AI" button covers a missed run.
 */
function scheduleMapping(studyId, delayMs = DEBOUNCE_MS) {
  if (!studyId) return;
  clearTimeout(timers.get(studyId));
  const timer = setTimeout(() => {
    timers.delete(studyId);
    runMapping(studyId).catch((e) => console.error(`KPI mapping failed for study ${studyId}:`, e.message));
  }, delayMs);
  if (timer.unref) timer.unref();
  timers.set(studyId, timer);
  store.update("studies", { id: studyId }, { kpi_mapping_status: "queued" }).catch(() => {});
}

// ---------- Review ----------

function kpiFor(study, kpiKey) {
  return recipeKpis(study).find((kpi) => kpi.key === kpiKey) || null;
}

async function review(studyId, kpiKey, action, actor) {
  const study = await store.findOne("studies", { id: studyId });
  const kpi = study && kpiFor(study, kpiKey);
  if (!kpi) throw Object.assign(new Error("That KPI is not part of this study's recipe."), { status: 400 });
  const row = parseRow(await store.findOne("kpi_mappings", { study_id: studyId, kpi_key: kpiKey }));
  if (action === "approve") {
    const questionsById = new Map((await candidateQuestions(studyId)).map((q) => [q.id, q]));
    if (!row || !Object.keys(row.inputs).length || !stillValid(kpi, row, questionsById)) {
      throw Object.assign(new Error("There is no valid mapping to approve. Choose the questions first."), { status: 400 });
    }
  }
  await saveMapping(studyId, kpiKey, { status: action === "approve" ? "approved" : "rejected", reviewed_by: actor, reviewed_at: store.nowSql() });
  logAudit(actor, `kpi_mapping_${action === "approve" ? "approved" : "rejected"}`, "studies", studyId, { kpi: kpiKey });
}

/** A researcher's own choice of questions; approved as it is saved. */
async function setManual(studyId, kpiKey, proposed, actor) {
  const study = await store.findOne("studies", { id: studyId });
  const kpi = study && kpiFor(study, kpiKey);
  if (!kpi) throw Object.assign(new Error("That KPI is not part of this study's recipe."), { status: 400 });
  const questionsById = new Map((await candidateQuestions(studyId)).map((q) => [q.id, q]));
  const { inputs, complete } = validateInputs(kpi, proposed, questionsById);
  if (!complete) throw Object.assign(new Error(`Choose a question for every required input of “${kpi.label}”${kpi.inputs.some((i) => i.options === "required") ? ", and the options that count" : ""}.`), { status: 400 });
  await saveMapping(studyId, kpiKey, { inputs, status: "approved", source: "manual", confidence: null, reason: "Chosen by a researcher.", reviewed_by: actor, reviewed_at: store.nowSql() });
  logAudit(actor, "kpi_mapping_manual", "studies", studyId, { kpi: kpiKey, inputs });
}

// ---------- Report ----------

/**
 * The study's recipe as story sections, each KPI computed from the report.
 * `forClient` drops anything not approved and suppresses small bases.
 */
async function recipeSections(study, report, { forClient = false, profiles, withSplits = false } = {}) {
  const type = studyTypeOf(study);
  if (!type) return null;
  const [mappings, questions] = await Promise.all([loadMappings(study.id), candidateQuestions(study.id)]);
  const questionsById = new Map(questions.map((q) => [q.id, q]));
  if (!profiles) profiles = await require("./staffAnalysis").loadProfiles(study.id);
  const ctx = { ...recipe.context(report, profiles), unit: STUDY_TYPES[type].unit };
  const minimum = Math.max(2, Number(study.minimum_base_size) || 5);
  return recipeFor(type).sections.map((section) => ({
    ...section,
    kpis: recipeFor(type).kpis.filter((kpi) => kpi.section === section.key).map((kpi) => {
      let mapping = mappings.get(kpi.key) || null;
      if (mapping && ["approved", "proposed"].includes(mapping.status) && !stillValid(kpi, mapping, questionsById)) mapping = null;
      const state = recipe.kpiState(kpi, mapping);
      if (forClient && !["auto", "approved"].includes(state)) return null;
      const result = recipe.computeRecipeKpi(kpi, mapping, ctx);
      const lowBase = !!result && result.value !== null && result.base < minimum;
      const sources = kpi.inputs.map((spec) => {
        const used = mapping && mapping.inputs[spec.role];
        const q = used && questionsById.get(Number(used.question_id));
        return { role: spec.role, label: spec.label, optional: !!spec.optional, needsOptions: spec.options || null, question: q || null, options: used ? used.options : [] };
      });
      const view = { key: kpi.key, label: kpi.label, definition: kpi.definition, state, mapping, sources, lowBase, inputs: kpi.inputs, ...(result || { value: null, display: state === "not_measured" ? "Not measured" : "—", basis: "", breakdown: [], base: 0 }) };
      if (forClient && lowBase) return { ...view, value: null, display: "—", basis: "Suppressed: small base", breakdown: [], splits: [] };
      if (withSplits && result && result.value !== null) {
        view.percentLike = /%$/.test(String(result.display));
        view.splits = Object.keys(recipe.SEGMENTS).map((segment) => recipe.splitKpi(kpi, mapping, ctx, segment, result)).filter(Boolean)
          .map((split) => ({ ...split, percentLike: view.percentLike || !!split.compares, groups: split.groups.map((g) => {
            const small = g.base < minimum;
            return forClient && small ? { ...g, value: null, display: "—", suppressed: true } : { ...g, lowBase: small };
          }) }));
      } else view.splits = [];
      return view;
    }).filter(Boolean),
  }));
}

/**
 * Mode effects (framework section 16) across the computed story: for every
 * split KPI, compare entry channels and recruitment routes, and list the
 * measures that differ materially -- so mixed-mode data is not silently pooled.
 */
function modeEffects(sections, study) {
  const minimum = Math.max(2, Number(study.minimum_base_size) || 5);
  const compared = [];
  for (const section of sections || []) for (const kpi of section.kpis) for (const split of kpi.splits || []) {
    if (!["channel", "recruitment"].includes(split.segment)) continue;
    const diff = recipe.modeDifference(split, minimum, split.percentLike);
    compared.push({ section: section.label, kpi: kpi.label, segment: split.label, compares: split.compares, groups: split.groups, diff });
  }
  const comparable = compared.filter((c) => c.diff);
  return {
    minimum,
    compared: comparable.length,
    material: comparable.filter((c) => c.diff.material),
    notComparable: compared.length - comparable.length,
    segments: [...new Set(compared.map((c) => c.segment))],
    rows: compared,
  };
}

/**
 * Hand-built KPIs join the story: filed under the section they name, or a
 * closing "Custom KPIs" section (including ones made for the six general
 * objectives before the study had a type).
 */
function attachCustomKpis(sections, customKpis) {
  const keys = new Set(sections.map((s) => s.key));
  const out = sections.map((s) => ({ ...s, custom: (customKpis || []).filter((k) => k.objective_key === s.key) }));
  const rest = (customKpis || []).filter((k) => !keys.has(k.objective_key));
  if (rest.length) out.push({ key: "custom", label: "Custom KPIs", description: "Measures built for this study by its researchers.", kpis: [], custom: rest });
  return out;
}

module.exports = {
  attachCustomKpis, modeEffects,
  provider, candidateQuestions, buildPrompt, parseReply, validateInputs, SYSTEM_PROMPT,
  loadMappings, runMapping, scheduleMapping, isPending, review, setManual, recipeSections, stillValid,
};

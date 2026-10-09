const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
require('express-async-errors');
const express = require('express');
const store = require('../lib/store');
const kpiMapping = require('../lib/kpiMapping');
const { RECIPES } = require('../lib/studyRecipes');

const originalFetch = global.fetch;
const savedEnv = { ...process.env };
const completed = (text) => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }));

let dir, server, base, study, q;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-recipes-'));
  await store.connect({ uri: '', file: path.join(dir, 'data.json') });
  study = await store.insert('studies', { name: 'Household noodles', study_type: 'in_home', minimum_base_size: 2 });
  const add = async (code, type, text, options) => ({ code, ...(await store.insert('questions', { study_id: study.id, code, type, text, active: 1, ...(options ? { options_json: JSON.stringify(options) } : {}) })) });
  q = {
    brand: await add('brand', 'single', 'Which brand of noodles did you cook?', ['Indomie', 'Golden Penny', 'Dangote']),
    bought: await add('bought', 'single', 'Did you buy noodles today?', ['Yes', 'No']),
    qty: await add('qty', 'numeric', 'How many packs did you cook?'),
    size: await add('hh', 'numeric', 'How many people live in your household?'),
    time: await add('time', 'time', 'What time did you eat?'),
    who: await add('who', 'multi', 'Who ate it?', ['Adults', 'Children']),
    note: await add('note', 'text', 'Anything else?'),
  };
  const people = [];
  for (let i = 0; i < 4; i++) {
    people.push(await store.insert('respondents', { study_id: study.id, is_practice: 0, activation_status: 'activated', consent_status: 'given', participation_start: '2026-01-01' }));
  }
  // Person 0: Indomie twice then Golden Penny, buys on the 5th and the 12th.
  // Person 1: Golden Penny twice. Person 2: one entry. Person 3: no entries.
  const entries = [
    [0, '2026-01-05T07:30:00Z', { brand: 'Indomie', bought: 'Yes', qty: '2', hh: '4', time: '07:30', who: 'Adults|Children' }],
    [0, '2026-01-08T19:00:00Z', { brand: 'Indomie', bought: 'No', qty: '1', hh: '4', time: '19:00', who: 'Children' }],
    [0, '2026-01-12T13:00:00Z', { brand: 'Golden Penny', bought: 'Yes', qty: '1', hh: '4', time: '13:00', who: 'Adults' }],
    [1, '2026-01-06T20:00:00Z', { brand: 'Golden Penny', bought: 'Yes', qty: '3', hh: '3', time: '20:00', who: 'Adults' }],
    [1, '2026-01-13T20:30:00Z', { brand: 'Golden Penny', bought: 'No', qty: '3', hh: '3', time: '20:30', who: 'Adults' }],
    [2, '2026-01-07T08:00:00Z', { brand: 'Dangote', bought: 'No', qty: '1', hh: '1', time: '08:00', who: 'Adults' }],
  ];
  const byCode = Object.fromEntries(Object.entries(q).map(([key, question]) => [question.code, question.id]));
  for (const [person, when, answers] of entries) {
    const record = await store.insert('diary_records', { study_id: study.id, respondent_id: people[person].id, status: 'submitted', is_practice: 0, occurrence_time: when, entry_time: when });
    for (const [code, value] of Object.entries(answers)) await store.insert('responses', { record_id: record.id, question_id: byCode[code], value, source: 'form' });
  }

  const app = express();
  app.set('views', path.join(__dirname, '../views')); app.set('view engine', 'ejs');
  app.locals.icon = require('../lib/icons').icon;
  app.locals.STUDY_TYPES = require('../lib/studyRecipes').STUDY_TYPES;
  Object.assign(app.locals, require('../lib/categories'));
  { const tabs = require('../lib/studyTabs'); Object.assign(app.locals, { STUDY_TABS: tabs.STUDY_TABS, studyTabHref: tabs.studyTabHref, studyTabNeighbours: tabs.studyTabNeighbours, renderPipeHtml: (t) => t }); }
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.session = { user: req.headers['x-test-role'] ? { role: req.headers['x-test-role'], name: 'Test staff', email: 'staff@example.test' } : null }; res.locals.user = req.session.user; res.locals.currentPath = req.path; next(); });
  app.use('/admin', require('../routes/admin'));
  app.use('/client', require('../routes/client'));
  server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
afterEach(() => { global.fetch = originalFetch; for (const key of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'KPI_MAPPING_PROVIDER', 'AI_SUMMARY_PROVIDER']) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } });

const useOpenAi = (reply) => {
  process.env.OPENAI_API_KEY = 'test-key'; process.env.KPI_MAPPING_PROVIDER = 'openai'; delete process.env.GEMINI_API_KEY;
  const calls = [];
  global.fetch = async (url, options) => { calls.push(JSON.parse(options.body)); return completed(typeof reply === 'function' ? reply(calls.length) : reply); };
  return calls;
};

async function sections(options) {
  const fresh = await store.findOne('studies', { id: study.id });
  const report = await require('../lib/studyReport').loadStudyReport(study.id);
  return (await kpiMapping.recipeSections(fresh, report, options)).flatMap((s) => s.kpis.map((k) => ({ ...k, section: s.key })));
}
const kpi = (list, key) => list.find((k) => k.key === key);

test('each recipe has its own KPIs in the framework story order, and every input names questions the calculations can read', () => {
  assert.deepEqual(RECIPES.ooh.sections.map((s) => s.label), ['Market Landscape', 'Consumption Occasions', 'Dayparts', 'Locations', 'Categories', 'Brands', 'Volume & Spend', 'Consumer Profiles', 'Opportunity Spaces', 'Conclusions']);
  assert.deepEqual(RECIPES.in_home.sections.map((s) => s.label), ['Household Landscape', 'Purchase Behaviour', 'Stocking', 'Preparation', 'Consumption', 'Brand Performance', 'Household Segments', 'Repurchase', 'Opportunity Areas']);
  const { CALCS } = require('../lib/recipeKpis');
  for (const recipe of Object.values(RECIPES)) for (const k of recipe.kpis) {
    assert.ok(CALCS[k.calc], `${k.key} uses a calculation that exists`);
    assert.ok(recipe.sections.some((s) => s.key === k.section && !s.narrative), `${k.key} sits in a measured section`);
  }
  const ooh = new Set(RECIPES.ooh.kpis.map((k) => k.key)), home = new Set(RECIPES.in_home.kpis.map((k) => k.key));
  assert.ok(ooh.has('consumption_location') && !home.has('consumption_location'));
  assert.ok(home.has('household_stock') && !ooh.has('household_stock'));
});

test('with no AI provider the study is marked unconfigured and nothing is invented', async () => {
  delete process.env.OPENAI_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.KPI_MAPPING_PROVIDER;
  assert.equal((await kpiMapping.runMapping(study.id)).status, 'unconfigured');
  assert.equal((await store.findOne('studies', { id: study.id })).kpi_mapping_status, 'unconfigured');
  assert.equal((await store.find('kpi_mappings', { study_id: study.id })).length, 0);
});

test('the AI proposal is validated against the questionnaire: wrong ids, wrong types and invented options are dropped', async () => {
  const calls = useOpenAi(JSON.stringify({ mappings: [
    { kpi: 'brand_penetration', inputs: { brand: { question_id: q.brand.id } }, confidence: 0.94, reason: 'Brand question.' },
    { kpi: 'main_brand', inputs: { brand: { question_id: q.brand.id } }, confidence: 0.9, reason: 'Brand question.' },
    { kpi: 'switching', inputs: { brand: { question_id: q.brand.id } }, confidence: 0.9, reason: 'Brand question.' },
    { kpi: 'purchase_frequency', inputs: { purchase: { question_id: q.bought.id, options: ['yes'] } }, confidence: 0.8, reason: 'Bought today.' },
    { kpi: 'repurchase_cycle', inputs: { purchase: { question_id: q.bought.id, options: ['Yes', 'Definitely'] } }, confidence: 0.8, reason: 'Bought today.' },
    { kpi: 'consumption_occasion', inputs: { occasion: { question_id: q.time.id } }, confidence: 0.7, reason: 'Time eaten.' },
    { kpi: 'household_consumer', inputs: { consumer: { question_id: q.who.id } }, confidence: 0.9, reason: 'Who ate it.' },
    { kpi: 'per_capita', inputs: { quantity: { question_id: q.qty.id }, household_size: { question_id: q.size.id } }, confidence: 0.8, reason: 'Packs / household size.' },
    { kpi: 'household_volume', inputs: { quantity: { question_id: q.qty.id } }, confidence: 0.8, reason: 'Packs.' },
    { kpi: 'purchase_channel', inputs: { channel: { question_id: 999999 } }, confidence: 0.9, reason: 'Made up.' },
    { kpi: 'preparation_method', inputs: { preparation: { question_id: q.qty.id } }, confidence: 0.9, reason: 'Wrong type.' },
    { kpi: 'household_stock', inputs: { stock: { question_id: q.note.id } }, confidence: 0.9, reason: 'Open text.' },
  ] }));
  assert.equal((await kpiMapping.runMapping(study.id, { actor: 'tester' })).status, 'done');
  assert.equal(calls.length, 1);
  assert.match(calls[0].input, /json/i, 'OpenAI JSON mode needs the word in the input');
  const prompt = JSON.parse(calls[0].input.slice(calls[0].input.indexOf('{')));
  assert.ok(prompt.questions.some((question) => question.id === q.brand.id && question.options.includes('Indomie')));
  assert.ok(!prompt.questions.some((question) => question.id === q.note.id), 'open-text questions are not offered');
  assert.ok(prompt.kpis.some((k) => k.kpi === 'repurchase_cycle' && k.inputs[0].options === 'required'));

  const rows = await kpiMapping.loadMappings(study.id);
  assert.equal(rows.get('brand_penetration').status, 'proposed');
  assert.deepEqual(rows.get('purchase_frequency').inputs.purchase, { question_id: q.bought.id, options: ['Yes'] }, 'option matched case-insensitively onto the real spelling');
  assert.deepEqual(rows.get('repurchase_cycle').inputs.purchase.options, ['Yes'], 'invented option dropped');
  for (const key of ['purchase_channel', 'preparation_method', 'household_stock']) assert.equal(rows.get(key).status, 'unmapped', key);

  const list = await sections();
  assert.equal(kpi(list, 'brand_penetration').state, 'awaiting');
  assert.equal(kpi(list, 'purchase_channel').state, 'not_measured');
  assert.equal(kpi(list, 'household_penetration').state, 'auto', 'optional input: computes without a mapping');
  const client = await sections({ forClient: true });
  assert.ok(!kpi(client, 'brand_penetration'), 'unapproved proposals never reach a client');
  assert.ok(!kpi(client, 'purchase_channel'));
});

test('approved mappings compute the In-Home KPIs deterministically', async () => {
  for (const key of ['brand_penetration', 'main_brand', 'switching', 'purchase_frequency', 'repurchase_cycle', 'consumption_occasion', 'household_consumer', 'per_capita', 'household_volume']) {
    await kpiMapping.review(study.id, key, 'approve', 'tester');
  }
  const list = await sections();
  assert.equal(kpi(list, 'household_penetration').display, '75%');
  assert.equal(kpi(list, 'household_penetration').basis, '3 of 4 households logged an occasion');
  assert.deepEqual(kpi(list, 'brand_penetration').breakdown.map((b) => [b.label, b.pct]), [['Golden Penny', 50], ['Dangote', 25], ['Indomie', 25]]);
  assert.equal(kpi(list, 'main_brand').display, 'Dangote · 33.33%', 'three-way tie, broken alphabetically');
  assert.equal(kpi(list, 'switching').basis, '1 of 3 consecutive occasions changed brand');
  assert.equal(kpi(list, 'purchase_frequency').display, '0.75 per household');
  assert.equal(kpi(list, 'repurchase_cycle').display, '7 days');
  assert.deepEqual(kpi(list, 'consumption_occasion').breakdown.map((b) => b.label), ['Dinner (6–10pm)', 'Breakfast (5–11am)', 'Lunch (11am–3pm)']);
  assert.equal(kpi(list, 'household_volume').display, '11');
  // (4 packs / 4 people + 6 / 3 + 1 / 1) / 3 households
  assert.equal(kpi(list, 'per_capita').display, '1.33');
  assert.deepEqual(kpi(list, 'usage_tiers').breakdown.map((b) => [b.label, b.pct]), [['Heavy (1)', 50], ['Medium (1)', 33.33], ['Light (1)', 16.67]]);
  const { CALCS } = require('../lib/recipeKpis');
  const four = CALCS.usage_tiers({ report: { entries: [1, 1, 1, 2, 2, 3, 4].map((respondentId) => ({ respondentId })) } });
  assert.deepEqual(four.breakdown.map((b) => b.label), ['Heavy (2)', 'Medium (1)', 'Light (1)'], 'four households split 2 / 1 / 1');
  assert.equal(kpi(list, 'trend').state, 'auto');
});

test('clients see approved KPIs only, with small bases suppressed', async () => {
  await store.update('studies', { id: study.id }, { minimum_base_size: 3 });
  const client = await sections({ forClient: true });
  assert.equal(kpi(client, 'brand_penetration').display, 'Golden Penny · 50%', 'base of 4 households');
  assert.equal(kpi(client, 'switching').display, '—', 'rests on 2 households');
  assert.equal(kpi(client, 'switching').basis, 'Suppressed: small base');
  await store.update('studies', { id: study.id }, { minimum_base_size: 2 });
});

test('a re-run keeps approved mappings, respects a rejection the AI repeats, and drops mappings to deleted questions', async () => {
  await kpiMapping.review(study.id, 'household_consumer', 'reject', 'tester');
  const calls = useOpenAi(JSON.stringify({ mappings: [
    { kpi: 'household_consumer', inputs: { consumer: { question_id: q.who.id } }, confidence: 0.9, reason: 'Same again.' },
    { kpi: 'brand_penetration', inputs: { brand: { question_id: q.bought.id } }, confidence: 0.2, reason: 'Should not be asked.' },
  ] }));
  await kpiMapping.runMapping(study.id);
  const asked = JSON.parse(calls[0].input.slice(calls[0].input.indexOf('{'))).kpis.map((k) => k.kpi);
  assert.ok(!asked.includes('brand_penetration'), 'approved KPIs are not re-asked');
  const rows = await kpiMapping.loadMappings(study.id);
  assert.equal(rows.get('brand_penetration').status, 'approved');
  assert.equal(rows.get('household_consumer').status, 'rejected');

  await store.update('questions', { id: q.size.id }, { active: 0 });
  assert.equal(kpi(await sections(), 'per_capita').state, 'not_measured', 'a deleted question un-measures its KPI');
  useOpenAi(JSON.stringify({ mappings: [] }));
  await kpiMapping.runMapping(study.id);
  assert.equal((await kpiMapping.loadMappings(study.id)).get('per_capita').status, 'unmapped');
  await store.update('questions', { id: q.size.id }, { active: 1 });
});

test('a researcher can map a KPI by hand, and an incomplete choice is refused', async () => {
  await assert.rejects(kpiMapping.setManual(study.id, 'purchase_channel', { channel: { question_id: q.qty.id } }, 'tester'), /Choose a question/);
  await assert.rejects(kpiMapping.setManual(study.id, 'repurchase_cycle', { purchase: { question_id: q.bought.id, options: [] } }, 'tester'), /options that count/);
  await kpiMapping.setManual(study.id, 'per_capita', { quantity: { question_id: q.qty.id }, household_size: { question_id: q.size.id } }, 'tester');
  const row = (await kpiMapping.loadMappings(study.id)).get('per_capita');
  assert.equal(row.status, 'approved');
  assert.equal(row.source, 'manual');
});

test('creating a study requires a study type, and the KPI page shows the tailored recipe for review', async () => {
  const post = (body) => fetch(`${base}/admin/studies`, { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'superadmin', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  assert.equal((await post({ name: 'No type', market_country_code: 'NG' })).status, 400);
  const created = await post({ name: 'Street snacks', market_country_code: 'NG', study_type: 'ooh' });
  assert.equal(created.status, 302);
  const made = await store.findOne('studies', { name: 'Street snacks' });
  assert.equal(made.study_type, 'ooh');

  const page = await (await fetch(`${base}/admin/studies/${study.id}/kpis`, { headers: { 'x-test-role': 'admin' } })).text();
  assert.match(page, /Tailored KPIs · In-Home Tracker/);
  assert.match(page, /Household Landscape/);
  assert.match(page, /Repurchase cycle/);
  assert.match(page, /Choose the questions yourself/);
  assert.match(page, /<option value="household_landscape">Household Landscape<\/option>/, 'custom KPIs are filed under story sections');

  const manual = await fetch(`${base}/admin/studies/${study.id}/kpi-mapping/purchase_channel/manual`, { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'admin', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q_channel: String(q.who.id) }) });
  assert.equal(manual.status, 302);
  assert.match(manual.headers.get('location'), /notice=/);
  assert.equal((await kpiMapping.loadMappings(study.id)).get('purchase_channel').status, 'approved');
});

test('typed studies report in story order on the AI summary page and the client dashboard', async () => {
  const summary = await (await fetch(`${base}/admin/ai-summary?study=${study.id}`, { headers: { 'x-test-role': 'admin' } })).text();
  assert.match(summary, /Report story/);
  assert.match(summary, /Household Landscape/);
  assert.match(summary, /Brand penetration/);
  assert.doesNotMatch(summary, /Study objectives/);
  const client = await fetch(`${base}/client?study=${study.id}`, { headers: { 'x-test-role': 'admin' } });
  assert.equal(client.status, 200);
  const html = await client.text();
  assert.match(html, /Report story/);
  assert.match(html, /Repurchase cycle/);
});

test('KPIs split by gender, age, location, recruitment and channel, and the mode screen flags material gaps', async () => {
  // WhatsApp: two breakfast entries from two households; web: four entries, three of them dinner.
  const records = await store.find('diary_records', { study_id: study.id }, { sort: { id: 1 } });
  for (const [i, r] of records.entries()) await store.update('diary_records', { id: r.id }, { channel: i === 0 || i === 5 ? 'whatsapp' : 'web' });
  const fresh = await store.findOne('studies', { id: study.id });
  const report = await require('../lib/studyReport').loadStudyReport(study.id);
  const story = await kpiMapping.recipeSections(fresh, report, { withSplits: true });
  const all = story.flatMap((s) => s.kpis);
  const occasion = kpi(all, 'consumption_occasion');
  const byChannel = occasion.splits.find((s) => s.segment === 'channel');
  assert.equal(byChannel.compares, 'share of “Dinner (6–10pm)”');
  assert.deepEqual(byChannel.groups.map((g) => [g.label, g.value]), [['Web', 75], ['WhatsApp', 0]]);
  assert.ok(kpi(all, 'brand_penetration').splits.some((s) => s.segment === 'gender'), 'person-level splits for cohort measures');
  assert.ok(!kpi(all, 'brand_penetration').splits.some((s) => s.segment === 'channel'), 'no channel split for a penetration measure');
  assert.ok(!kpi(all, 'usage_tiers').splits.length, 'whole-sample measures are not split');

  const { modeDifference } = require('../lib/recipeKpis');
  const split = { groups: [{ label: 'App', value: 52, base: 40 }, { label: 'WhatsApp', value: 38, base: 25 }, { label: 'Web', value: 90, base: 1 }] };
  assert.deepEqual(modeDifference(split, 5, true), { high: split.groups[0], low: split.groups[1], gap: 14, material: true, unit: 'points' }, 'the base-1 group is ignored');
  assert.equal(modeDifference({ groups: [{ label: 'A', value: 10, base: 9 }, { label: 'B', value: 9, base: 9 }] }, 5, false).material, false);

  const effects = kpiMapping.modeEffects(story, { minimum_base_size: 1 });
  assert.ok(effects.compared > 0);
  assert.ok(effects.material.some((m) => m.kpi === 'Consumption occasion' && m.segment === 'Entry channel'));
});

test('a summary with numbers the figures do not support cannot be approved without an explicit acceptance', async () => {
  const metrics = { base: { submitted_records: 6, contributing_respondents: 3 } };
  const row = await store.insert('ai_summaries', { study_id: study.id, narrative: 'There were 6 entries from 3 households, up 25% on last month.', metrics_json: JSON.stringify(metrics), review_status: 'draft', generated_at: '2026-10-09 10:00:00' });
  const approve = (body) => fetch(`${base}/admin/ai-summary/approve`, { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'admin', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ summary_id: String(row.id), ...body }) });
  const refused = await approve({ narrative: 'There were 6 entries from 3 households, up 25% on last month.' });
  assert.match(decodeURIComponent(refused.headers.get('location')), /not in the calculated figures: 25%/);
  assert.equal((await store.findOne('ai_summaries', { id: row.id })).review_status, 'draft');

  await approve({ narrative: 'There were 6 entries from 3 households.' });
  let saved = await store.findOne('ai_summaries', { id: row.id });
  assert.equal(saved.review_status, 'approved');
  assert.equal(saved.client_narrative, 'There were 6 entries from 3 households.');
  assert.equal(saved.approved_with_unsupported, 0);

  await approve({ narrative: 'There were 6 entries, roughly 2 per household.', allow_unsupported: '1' });
  saved = await store.findOne('ai_summaries', { id: row.id });
  assert.equal(saved.approved_with_unsupported, 1);
  assert.deepEqual(JSON.parse(saved.approved_claim_check_json).unsupported.map((n) => n.text), ['2']);

  const page = await (await fetch(`${base}/admin/ai-summary?study=${study.id}&summary=${row.id}`, { headers: { 'x-test-role': 'admin' } })).text();
  assert.match(page, /Number check/);
  assert.match(page, /1 of 3 numbers/);
  assert.match(page, /Mode effects/);
});

test('crosstabs put any questions on the side and top, on an occasion or respondent base, and export to CSV and Excel', async () => {
  const crosstab = require('../lib/crosstab');
  const report = await require('../lib/studyReport').loadStudyReport(study.id);
  const vars = crosstab.variables(report);
  assert.ok(vars.some((v) => v.id === 'q:brand' && v.kind === 'choice'));
  assert.ok(vars.some((v) => v.id === 'q:qty' && v.kind === 'numeric'));
  assert.ok(!vars.some((v) => v.id === 'q:note'), 'open text is not crosstabbed');

  const result = crosstab.buildCrosstab(report, { side: ['q:brand', 'q:qty'], top: ['q:who', 'seg:channel', 'q:qty'], minimum: 2 });
  assert.deepEqual(result.columns.map((c) => `${c.group}/${c.label}`), ['Total/Total', 'Who ate it?/Adults', 'Who ate it?/Children', 'Entry channel/Web', 'Entry channel/WhatsApp'].map((x) => x.replace('Who ate it?', 'who · Who ate it?')), 'numeric questions are not offered as columns');
  const brand = result.tables[0];
  assert.deepEqual(brand.bases, [6, 5, 2, 4, 2]);
  const gp = brand.rows.find((r) => r.label === 'Golden Penny');
  assert.deepEqual(gp.cells.map((c) => c.n), [3, 3, 0, 3, 0]);
  assert.equal(gp.cells[1].colPct, 60);
  assert.equal(gp.cells[3].rowPct, 100);
  assert.deepEqual(brand.rows.map((r) => r.label), ['Indomie', 'Golden Penny', 'Dangote'], 'questionnaire option order');
  const qty = result.tables[1];
  assert.equal(qty.kind, 'numeric');
  assert.equal(qty.stats[0].mean, 1.83);

  const people = crosstab.buildCrosstab(report, { side: ['q:brand'], top: ['seg:recruitment'], base: 'respondents', minimum: 2 });
  assert.deepEqual(people.tables[0].bases, [3, 3]);
  assert.equal(people.tables[0].rows.find((r) => r.label === 'Golden Penny').cells[0].n, 2, 'a person counts once per brand they used');
  assert.throws(() => crosstab.buildCrosstab(report, { side: [] }), /side break/);

  const qs = new URLSearchParams([['study', String(study.id)], ['side', 'q:brand'], ['top', 'q:who'], ['metrics', 'n'], ['metrics', 'colPct']]).toString();
  const page = await (await fetch(`${base}/admin/crosstab?${qs}`, { headers: { 'x-test-role': 'admin' } })).text();
  assert.match(page, /Side break \(rows\)/);
  assert.match(page, /Golden Penny/);
  assert.match(page, /export\.xlsx\?/);
  const csv = await fetch(`${base}/admin/crosstab/export.csv?${qs}`, { headers: { 'x-test-role': 'admin' } });
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /"Golden Penny","Count",3,3,0/);
  assert.match(text, /"","Column %",50,60,0/);
  const xlsx = await fetch(`${base}/admin/crosstab/export.xlsx?${qs}`, { headers: { 'x-test-role': 'admin' } });
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  const XLSX = require('xlsx');
  const sheet = XLSX.read(Buffer.from(await xlsx.arrayBuffer())).Sheets.Crosstab;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.ok(rows.some((r) => r[0] === 'Golden Penny' && r[1] === 'Count' && r[2] === 3));
});

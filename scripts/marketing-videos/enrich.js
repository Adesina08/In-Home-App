// Turns the base demo seed into a fuller, entirely fictional marketing dataset:
// a malt-drink diary in Lagos with made-up brands, respondents, two weeks of
// entries and rendered pack-shot photos. Runs only against the demo database.
const path = require('path');
const fs = require('fs');
const { APP, WORK, FFMPEG } = require('./config');
const { execFileSync } = require('child_process');
const { LINES } = require('./voice');
require(path.join(APP, 'node_modules', 'dotenv')).config({ path: path.join(APP, '.env') });
if (process.env.MONGODB_URI) throw new Error('Refusing: MONGODB_URI is set.');
if (!String(process.env.LOCAL_DB_PATH).includes('/marketing-videos/.work/')) throw new Error('Refusing: not the demo database.');
const store = require(path.join(APP, 'lib', 'store'));
const { v4: uuidv4 } = require(path.join(APP, 'node_modules', 'uuid'));

const BRANDS = [
  { name: 'Sunrise Malt', c1: '#f59e0b', c2: '#b45309', share: 0.36 },
  { name: 'Kora Malt', c1: '#16a34a', c2: '#14532d', share: 0.27 },
  { name: 'Maltwell', c1: '#2563eb', c2: '#1e3a8a', share: 0.22 },
  { name: 'Royal Grain', c1: '#9333ea', c2: '#4c1d95', share: 0.15 },
];
const NAMES = ['Adaeze Okafor', 'Kunle Adebayo', 'Zainab Bello', 'Chinedu Okeke', 'Yetunde Ajayi', 'Musa Danjuma', 'Ifeoma Nnaji', 'Tolu Fashola', 'Halima Sani', 'Obinna Eze', 'Bisi Ogunleye', 'Aisha Lawal', 'Femi Oladipo', 'Uche Ibe', 'Ngozi Arinze', 'Seyi Akande', 'Hauwa Garba', 'Dayo Coker'];
const OCCASIONS = [['Breakfast', 0.34], ['Lunch', 0.14], ['Dinner', 0.2], ['Snack', 0.22], ['Social Gathering', 0.1]];
const LOCATIONS = [['Home', 0.62], ['Work', 0.16], ['Restaurant', 0.08], ['Outdoors', 0.14]];
const COMPANIONS = ['Alone', 'Family', 'Friends', 'Colleagues'];
const SOURCES = [['Supermarket', 0.38], ['Retail Store', 0.34], ['Already at home', 0.22], ['Online', 0.06]];
const REASONS = {
  'Sunrise Malt': ['My kids ask for it every morning before school.', 'It tastes rich and it is always in the fridge.', 'Goes well with bread and akara for breakfast.', 'Good energy before a long day.'],
  'Kora Malt': ['It was on promo at the supermarket this week.', 'Less sweet than the others, I prefer that.', 'My husband buys it in packs for the house.'],
  Maltwell: ['Cold Maltwell after work is my small treat.', 'Bought it with lunch near the office.', 'The new can size is easy to carry.'],
  'Royal Grain': ['We served it to guests at a family gathering.', 'Feels premium for when visitors come.', 'Tried it because a friend recommended it.'],
};

// Seeded random numbers so every reset produces the same charts.
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = (weighted) => { let r = rand(); for (const [v, w] of weighted) { if ((r -= w) <= 0) return v; } return weighted[0][0]; };
const pad = (n) => String(n).padStart(2, '0');
const sql = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const hourFor = { Breakfast: 7, Lunch: 13, Dinner: 19, Snack: 16, 'Social Gathering': 18 };

// Real, unbranded stock photos (Pixabay, see stock.js), chosen to fit each occasion.
const OCCASION_PHOTOS = {
  Breakfast: [1835478, 8200753, 3242369, 2557548, 872601],
  Lunch: [4659747, 2741251, 4857512],
  Dinner: [8257030, 5994998, 4280835],
  Snack: [872601, 4280835, 6600644, 5994998],
  'Social Gathering': [7240486, 2741251, 4857512],
};
// Stock clips given an AI-voiced diary line (voice.js), logged by these respondents with matching answers.
const VIDEO_ENTRIES = [
  { clip: 9830, voice: 'clip-9830', who: 'Adaeze Okafor', occasion: 'Dinner', brand: 'Sunrise Malt', location: 'Home', companions: 'Alone', source: 'Retail Store', daysAgo: 1 },
  { clip: 31672, voice: 'clip-31672', who: 'Zainab Bello', occasion: 'Lunch', brand: 'Maltwell', location: 'Work', companions: 'Colleagues', source: 'Retail Store', daysAgo: 2 },
  { clip: 2339, voice: 'clip-2339', who: 'Kunle Adebayo', occasion: 'Lunch', brand: 'Kora Malt', location: 'Restaurant', companions: 'Family', source: 'Retail Store', daysAgo: 3 },
  { clip: 172686, voice: 'clip-172686', who: 'Yetunde Ajayi', occasion: 'Dinner', brand: 'Sunrise Malt', location: 'Home', companions: 'Family', source: 'Supermarket', daysAgo: 4 },
  { clip: 7647, voice: 'clip-7647', who: 'Ifeoma Nnaji', occasion: 'Breakfast', brand: 'Kora Malt', location: 'Home', companions: 'Family', source: 'Already at home', daysAgo: 5 },
  { clip: 169349, voice: 'clip-169349', who: 'Chinedu Okeke', occasion: 'Breakfast', brand: 'Royal Grain', location: 'Home', companions: 'Family', source: 'Supermarket', daysAgo: 6 },
];

function stockPhotos(uploadDir) {
  const out = {};
  for (const [occasion, ids] of Object.entries(OCCASION_PHOTOS)) {
    out[occasion] = ids.map((id) => {
      const name = `stock-${id}.jpg`;
      fs.copyFileSync(path.join(WORK, 'stock', 'picked', `photo-${id}.jpg`), path.join(uploadDir, name));
      return `/uploads/${name}`;
    });
  }
  return out;
}

/** A stock clip with its AI-voiced line laid over it, as a respondent's 1280x720 phone video. */
function voicedClip(uploadDir, { clip, voice }) {
  const name = `resp-${clip}.mp4`;
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-i', path.join(WORK, 'stock', 'picked', `video-${clip}.mp4`),
    '-i', path.join(WORK, 'voices', `${voice}.wav`), '-filter_complex', '[1:a]adelay=600|600,apad=pad_dur=1,loudnorm=I=-16[a]',
    '-map', '0:v:0', '-map', '[a]', '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '128k', '-shortest', path.join(uploadDir, name)]);
  return `/uploads/${name}`;
}

(async () => {
  await store.connect();
  const uploadDir = process.env.UPLOAD_DIR;
  fs.mkdirSync(uploadDir, { recursive: true });
  const photos = stockPhotos(uploadDir);

  const study = await store.findOne('studies', { id: 1 });
  const start = new Date(); start.setDate(start.getDate() - 14); start.setHours(0, 0, 0, 0);
  await store.update('studies', { id: study.id }, {
    name: 'Malt Moments Diary · Lagos', category: 'Malt Beverage', market: 'Nigeria', market_country_code: 'NG',
    minimum_base_size: 5, start_date: sql(start).slice(0, 10), invite_brief: 'Tell us every time you enjoy a malt drink for the next two weeks.',
  });

  await store.update('consent_versions', { study_id: study.id }, {
    body: 'Thank you for considering the Malt Moments Diary. For the next two weeks we will ask you to record each time you have a malt drink: a few quick questions and a photo. '
      + 'Your answers and photos are used only for research, are stored securely, and are never shared with your name attached. '
      + 'Taking part is voluntary. You can stop at any time from the app or by contacting the research team, and you will still receive the rewards you have earned.',
  });
  const questions = await store.find('questions', { study_id: study.id });
  const q = Object.fromEntries(questions.map((x) => [x.code, x]));
  await store.update('questions', { id: q.brand.id }, { options_json: JSON.stringify([...BRANDS.map((b) => b.name), 'Other']), text: 'Which malt drink brand did you have?' });
  await store.update('questions', { id: q.reason.id }, { text: 'Why did you choose this brand today?' });
  await store.update('questions', { id: q.occasion.id }, { text: 'When did you have your malt drink?' });
  await store.update('questions', { id: q.evidence.id }, { text: 'Take a photo of your drink' });
  await store.update('questions', { id: q.video_evidence.id }, { text: 'Optional: record a short video telling us about it' });
  await store.update('questions', { id: q.source.id }, { text: 'Where did you buy it?' });
  await store.update('questions', { id: q.quantity.id }, { text: 'How many bottles or cans did you have?' });
  const rename = { 'Brand A': 'Sunrise Malt', 'Brand B': 'Kora Malt', 'Brand C': 'Maltwell' };
  for (const [from, to] of Object.entries(rename)) await store.update('responses', { question_id: q.brand.id, value: from }, { value: to });
  for (const m of await store.find('media', { file_path: '/uploads/sample-placeholder.jpg' })) {
    const occasion = (await store.findOne('responses', { record_id: m.record_id, question_id: q.occasion.id }))?.value || 'Snack';
    // Unbranded photos: brand detection honestly finds nothing.
    await store.update('media', { id: m.id }, { media_type: 'photo', file_path: (photos[occasion] || photos.Snack)[0], detection_status: 'unavailable', detected_brand: null, detection_confidence: null, detection_category: null });
  }
  // The base seed's respondents only have a couple of days of entries, so start them recently.
  const recent = new Date(); recent.setDate(recent.getDate() - 2); recent.setHours(0, 0, 0, 0);
  await store.update('respondents', { study_id: study.id }, { media_consent: true, participation_start: sql(recent) });

  const brandWeights = BRANDS.map((b) => [b.name, b.share]);
  let entries = 0;
  for (const [i, name] of NAMES.entries()) {
    const { id: rid } = await store.insert('respondents', {
      study_id: study.id, respondent_code: `R01-${String(20 + i).padStart(4, '0')}`, name, contact: `+23480${String(10000000 + i * 7919).slice(0, 8)}`,
      recruitment_mode: i % 3 ? 'remote' : 'f2f', preferred_channel: i % 4 ? 'app' : 'whatsapp', consent_status: 'given', consent_at: sql(start),
      activation_status: 'active', unique_token: uuidv4(), is_practice: 0, media_consent: true, participation_start: sql(start), activated_at: sql(start),
      gender: i % 2 ? 'Male' : 'Female', age: 22 + ((i * 7) % 28), location: ['Ikeja', 'Surulere', 'Lekki', 'Yaba', 'Ikorodu'][i % 5],
    });
    await store.insert('respondent_profile_snapshots', { study_id: study.id, respondent_id: rid, snapshot_json: JSON.stringify({ gender: i % 2 ? 'Men' : 'Women', age: 22 + ((i * 7) % 28), location: 'Lagos' }) });
    const favourite = pick(brandWeights);
    for (let day = 0; day < 14; day++) {
      if (rand() < 0.12) continue;
      const brand = rand() < 0.7 ? favourite : pick(brandWeights);
      const occasion = pick(OCCASIONS);
      const when = new Date(start); when.setDate(when.getDate() + day); when.setHours(hourFor[occasion], Math.floor(rand() * 50), 0, 0);
      if (when > new Date()) continue;
      const entered = new Date(when.getTime() + (20 + rand() * 90) * 60000);
      const { id: rec } = await store.insert('diary_records', {
        respondent_id: rid, study_id: study.id, period_label: sql(when).slice(0, 10), occurrence_time: sql(when), entry_time: sql(entered), submit_time: sql(entered),
        channel: i % 4 ? 'app' : 'whatsapp', status: 'submitted', is_practice: 0, entry_mode: 'standard', review_status: 'accepted',
      });
      const ans = (qq, value) => store.insert('responses', { record_id: rec, question_id: qq.id, value, study_version: 1 });
      await ans(q.occasion, occasion);
      await ans(q.brand, brand);
      await ans(q.location, occasion === 'Social Gathering' ? 'Outdoors' : pick(LOCATIONS));
      await ans(q.companions, occasion === 'Breakfast' || occasion === 'Dinner' ? 'Family' : COMPANIONS[Math.floor(rand() * 4)]);
      await ans(q.quantity, String(occasion === 'Social Gathering' ? 2 + Math.floor(rand() * 3) : 1 + (rand() < 0.2 ? 1 : 0)));
      if (rand() < 0.75) { const pool = REASONS[brand]; await ans(q.reason, pool[Math.floor(rand() * pool.length)]); }
      await ans(q.source, pick(SOURCES));
      const pool = photos[occasion];
      await store.insert('media', { record_id: rec, question_id: q.evidence.id, media_type: 'photo', file_path: pool[Math.floor(rand() * pool.length)], detection_status: 'unavailable' });
      entries++;
    }
  }
  // Respondent video entries: real stock footage, AI-voiced, with answers matching what is said.
  for (const v of VIDEO_ENTRIES) {
    const person = await store.findOne('respondents', { study_id: study.id, name: v.who });
    const when = new Date(); when.setDate(when.getDate() - v.daysAgo); when.setHours(hourFor[v.occasion], 15, 0, 0);
    const entered = new Date(when.getTime() + 25 * 60000);
    const { id: rec } = await store.insert('diary_records', {
      respondent_id: person.id, study_id: study.id, period_label: sql(when).slice(0, 10), occurrence_time: sql(when), entry_time: sql(entered), submit_time: sql(entered),
      channel: 'app', status: 'submitted', is_practice: 0, entry_mode: 'standard', review_status: 'accepted',
    });
    const ans = (qq, value) => store.insert('responses', { record_id: rec, question_id: qq.id, value, study_version: 1 });
    for (const [code, value] of [['occasion', v.occasion], ['brand', v.brand], ['location', v.location], ['companions', v.companions], ['quantity', '1'], ['source', v.source]]) await ans(q[code], value);
    await ans(q.reason, LINES[v.voice].text);
    await store.insert('media', { record_id: rec, question_id: q.evidence.id, media_type: 'photo', file_path: photos[v.occasion][0], detection_status: 'unavailable' });
    await store.insert('media', { record_id: rec, question_id: q.video_evidence.id, media_type: 'video', file_path: voicedClip(uploadDir, v), mimetype: 'video/mp4',
      transcript_status: 'done', transcript_text: LINES[v.voice].text, detection_status: 'unavailable' });
    entries++;
  }
  // Rewards demo (Blessing, the mobile app's demo login): setup finished, six days into
  // the diary with entries on most days, and a completed one-time profile.
  const blessing = await store.findOne('respondents', { study_id: study.id, name: 'Blessing Adeyemi' });
  const sixDaysAgo = new Date(); sixDaysAgo.setDate(sixDaysAgo.getDate() - 6); sixDaysAgo.setHours(0, 0, 0, 0);
  await store.update('respondents', { id: blessing.id }, { participation_start: sql(sixDaysAgo), handover_at: sql(sixDaysAgo), tutorial_completed_at: sql(sixDaysAgo) });
  for (const [daysAgo, occasion, brand] of [[5, 'Breakfast', 'Sunrise Malt'], [4, 'Snack', 'Kora Malt'], [3, 'Dinner', 'Sunrise Malt']]) {
    const when = new Date(); when.setDate(when.getDate() - daysAgo); when.setHours(hourFor[occasion], 10, 0, 0);
    const entered = new Date(when.getTime() + 30 * 60000);
    const { id: rec } = await store.insert('diary_records', {
      respondent_id: blessing.id, study_id: study.id, period_label: sql(when).slice(0, 10), occurrence_time: sql(when), entry_time: sql(entered), submit_time: sql(entered),
      channel: 'app', status: 'submitted', is_practice: 0, entry_mode: 'standard', review_status: 'accepted',
    });
    const ans = (qq, value) => store.insert('responses', { record_id: rec, question_id: qq.id, value, study_version: 1 });
    for (const [code, value] of [['occasion', occasion], ['brand', brand], ['location', 'Home'], ['companions', 'Family'], ['quantity', '1'], ['source', 'Supermarket']]) await ans(q[code], value);
    await store.insert('media', { record_id: rec, question_id: q.evidence.id, media_type: 'photo', file_path: photos[occasion][1], detection_status: 'unavailable' });
  }
  const profiles = require(path.join(APP, 'lib', 'respondentProfiles'));
  const account = await store.findOne('respondent_accounts', { id: blessing.account_id });
  const profile = await profiles.ensureForAccount(account);
  const done = await profiles.completeProfile(profile.id, { name: 'Blessing Adeyemi', location: 'Surulere, Lagos', age: 34, gender: 'female', education_level: 'tertiary_university', occupation: 'Trader / retail', religion: 'Christianity', marital_status: 'married', recontact_consent: 'yes' });
  if (!done.ok) throw new Error(`Demo profile invalid: ${JSON.stringify(done.errors)}`);

  // Face-to-face recruitment screener (asked by interviewers before registering someone).
  await store.update('studies', { id: study.id }, {
    screener_questions: [
      { code: 'age_band', text: 'Is the respondent aged 18 to 55?', options: ['Yes', 'No'], allowed: ['Yes'] },
      { code: 'malt_drinker', text: 'Have they had a malt drink in the past 7 days?', options: ['Yes', 'No'], allowed: ['Yes'] },
      { code: 'industry', text: 'Does anyone in the household work in market research or for a drinks company?', options: ['No', 'Yes'], allowed: ['No'] },
    ],
    close_out_questions: [
      { code: 'experience', text: 'How easy was it to keep the diary?', type: 'single', options: ['Very easy', 'Easy', 'Hard'] },
      { code: 'feedback', text: 'Anything we could make better?', type: 'text' },
    ],
  });

  // Flags older than 48 hours go to the exception follow-up call queue.
  const threeDaysAgo = new Date(); threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  for (const flag of (await store.find('qc_flags', { status: 'open' })).slice(0, 4)) await store.update('qc_flags', { id: flag.id }, { created_time: sql(threeDaysAgo) });

  // An empty study for the questionnaire-import video.
  const { id: noodles } = await store.insert('studies', { name: 'Noodle Moments · Abuja', market: 'Nigeria', market_country_code: 'NG', market_regions: [], category: 'Instant Noodles', diary_mode: 'daily', recruitment_mode: 'hybrid', status: 'draft' });
  await store.insert('consent_versions', { study_id: noodles, version: 1, status: 'approved', approved_by: 'Research Lead', approved_at: store.nowSql(), body: 'Thank you for joining Noodle Moments. For two weeks, tell us each time you eat instant noodles.' });

  // The demo client may see media, quotes and exports (the access screen's "grant").
  const client = await store.findOne('users', { email: 'client@inicio.demo' });
  await require(path.join(APP, 'lib', 'researchOperations')).insertOnce('client_grants', `${study.id}:${client.id}`, { study_id: study.id, user_id: client.id });
  await store.update('client_grants', { id: `${study.id}:${client.id}` }, { enabled: true, media: true, text: true, exports: true });
  console.log(`Demo data ready: ${NAMES.length} extra respondents, ${entries} entries (${VIDEO_ENTRIES.length} with video).`);
  await store.close();
})().catch((e) => { console.error(e); process.exit(1); });

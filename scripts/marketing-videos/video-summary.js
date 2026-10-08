// Runs the app's real Video Summary pipeline on the demo respondent videos:
// Gemini watches each video, findings are synthesised (Gemini), the highlight
// reel is cut, and the summary is approved for the client view.
// Only fictional demo media (stock footage + AI voices) is sent to Gemini.
const fs = require('fs');
const path = require('path');
const { APP } = require('./config');
if (process.env.MONGODB_URI || !String(process.env.LOCAL_DB_PATH).includes('/marketing-videos/.work/')) throw new Error('Refusing: not the demo database.');
const real = require(path.join(APP, 'node_modules', 'dotenv')).parse(fs.readFileSync(path.join(APP, '.env')));
if (!real.GEMINI_API_KEY) { console.log('No GEMINI_API_KEY in .env; skipping the video summary.'); process.exit(0); }
Object.assign(process.env, { AI_SUMMARY_PROVIDER: 'gemini', GEMINI_API_KEY: real.GEMINI_API_KEY }, real.GEMINI_MODEL ? { GEMINI_MODEL: real.GEMINI_MODEL } : {});
const store = require(path.join(APP, 'lib', 'store'));
const videoSummary = require(path.join(APP, 'lib', 'videoSummary'));

// A researcher's review pass, done through the app's own review function:
// keep the clearest findings, word them as insights, fix misheard brand names.
const PICKS = [
  [/Sunday|family tradition/i, 'Malt is part of family rituals: a small glass for everyone at Sunday dinner.'],
  [/afternoon|meeting/i, 'At work, a cold malt is an afternoon treat before the next meeting.'],
  [/rice/i, 'Malt is chosen to go with meals: "it goes well with rice".'],
  [/finish their food|son/i, 'Parents use malt, sometimes mixed with milk, to get children through breakfast.'],
  [/relax/i, 'In the evening, a warm malt with milk helps people unwind.'],
  [/packs at the supermarket/i, 'Bought in packs at the supermarket so it lasts the week.'],
];
async function curate(row) {
  const s = videoSummary.hydrate(row);
  const used = new Set();
  const points = [];
  for (const [pattern, text] of PICKS) {
    const index = s.points.findIndex((p, i) => !used.has(i) && pattern.test(p.point) && (p.clips || []).length);
    if (index < 0) continue;
    used.add(index);
    points.push({ index, include: '1', order: points.length + 1, point: text,
      clips: s.points[index].clips.map((c) => ({ include: '1', moment_id: c.moment_id, start: c.start, end: c.end })) });
  }
  const overview = String(s.overview).replace(/Royal Green/g, 'Royal Grain');
  await videoSummary.saveReview(1, row.id, { overview, points, revision: row.review_revision });
  await videoSummary.buildReel(row.id);
  const saved = await store.findOne('video_summaries', { id: row.id });
  if (saved.reel_status !== 'ready') throw new Error(`Reviewed reel not built: ${saved.reel_error || saved.reel_status}`);
  return saved;
}

(async () => {
  await store.connect();
  // The free Gemini tier allows ~15 requests a minute. Finished per-video
  // analysis is cached on the media row, so each retry picks up where it stopped.
  let row = process.argv.includes('--curate-only') ? await store.findOne('video_summaries', { study_id: 1, generation_status: 'ready' }, { sort: { id: -1 } }) : null;
  for (let attempt = 1; !row; attempt++) {
    try { row = await videoSummary.generateVideoSummary(1, { generatedBy: 'research@inicio.demo', force: true }); break; }
    catch (e) {
      if (!/429|quota|rate/i.test(e.message) || attempt >= 8) throw e;
      console.log(`Gemini rate limit (attempt ${attempt}); waiting 65s...`);
      await new Promise((r) => setTimeout(r, 65000));
    }
  }
  if (row.reel_status === 'pending') await videoSummary.buildReel(row.id);
  row = await store.findOne('video_summaries', { id: row.id });
  if (row.reel_status !== 'ready') throw new Error(`Reel not built: ${row.reel_status} ${row.reel_error || ''}`);
  row = await curate(row);
  row = await videoSummary.approveVideoSummary(1, row.id, { approvedBy: 'research@inicio.demo', revision: row.review_revision, evidenceReviewed: '1', coverageAcknowledged: '1' });
  const s = videoSummary.hydrate(row);
  console.log(`Video summary ${row.id}: ${s.points.length} findings, reel ${Math.round(row.reel_seconds)}s, approved. ${String(row.overview).slice(0, 140)}...`);
  await store.close();
})().catch((e) => { console.error('Video summary failed:', e.message); process.exit(1); });

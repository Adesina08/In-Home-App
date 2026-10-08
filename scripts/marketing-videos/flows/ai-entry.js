// Video: AI-assisted entry. Part 1 (phone): the respondent records a short video
// instead of answering questions. Part 2 (desktop): the app's real analysis
// (Azure Vision + Gemini transcription) has filled in the answers for review.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Recorder, staffLogin, BASE } = require('../rec');
const { DB, WORK, FFMPEG } = require('../config');

/** Phone camera + microphone: the stock pour-over-ice clip and the AI voice, timed to start with recording. */
function cameraAndMic() {
  const camera = path.join(WORK, 'ai-camera.mjpeg'), mic = path.join(WORK, 'ai-mic.wav');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(WORK, 'stock', 'picked', 'video-79908.mp4'), '-t', '30', '-r', '15',
    '-vf', 'scale=-2:960,crop=720:960,format=yuvj420p', '-q:v', '3', camera]);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(WORK, 'voices', 'ai-entry.wav'),
    '-af', 'adelay=3000|3000,apad=pad_dur=20,loudnorm=I=-16', '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', mic]);
  return { camera, mic };
}

async function phonePart() {
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const person = db.collections.respondents.find((r) => r.name === 'Blessing Adeyemi');
  const { camera, mic } = cameraAndMic();
  const r = new Recorder('ai-entry-phone', { width: 390, height: 844, mobile: true, scale: 2, camera, mic });
  const page = await r.open();
  await r.goto(`/r/${person.unique_token}/diary/new`);

  await r.start();
  r.cue('No time for questions?', 'Respondents can just record a video instead');
  await r.wait(2200);
  await r.click(page.locator('a[href*="mode=video"]'), { nav: true, after: 1000 });

  r.cue('A teleprompter keeps them on topic', 'Built from your own questionnaire');
  await r.scrollBy(300, 1400); await r.wait(1800);
  await r.click(page.getByText('Tap to open front camera'), { after: 0 });
  r.mark('mic-open');                                  // the fake mic starts its file now (3s lead-in)
  await r.wait(2000);

  r.cue('They just talk about the moment', 'What, when, where, with whom');
  await r.click('#camShutterBtn', { after: 0 });      // start recording
  await r.wait(12800);                                 // the spoken line
  await r.click('#camShutterBtn', { after: 1200 });   // stop
  await r.click('#camUseBtn', { after: 1200 });

  r.cue('One tap to submit — done');
  await r.click(page.locator('form[action$="/analyze-video"] button[type=submit]'), { nav: true, after: 2600 });
  await r.wait(1200);
  return r.stop();
}

/** Wait until the background analysis has written AI answers for the newest video entry. */
async function waitForAnalysis(timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
        // The local store keeps ids in _id on disk.
    const rec = db.collections.diary_records.filter((x) => x.entry_mode === 'video').sort((a, b) => b._id - a._id)[0];
    const answers = rec ? db.collections.responses.filter((x) => x.record_id === rec._id && x.source === 'ai_video') : [];
    if (answers.length) return { recordId: rec._id, answers: answers.length };
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error('The AI analysis did not finish in time.');
}

async function reviewPart(recordId) {
  const r = new Recorder('ai-entry-review', { width: 1440, height: 900, scale: 1.334 });
  const page = await r.open();
  await staffLogin(page);
  await r.goto(`/admin/studies/1/records/${recordId}`);

  await r.start();
  r.cue('Seconds later, AI has filled in the diary', 'From what was said and shown in the video');
  await r.wait(3500);
  await r.scrollBy(380, 1800); await r.wait(2500);
  r.cue('Every AI answer is marked for review', 'Nothing unconfirmed reaches a client');
  await r.wait(1500);
  r.cue('Confirm with a click', 'Correct, change or remove each answer');
  const correct = page.getByText('Correct', { exact: true });
  for (let i = 0; i < await correct.count(); i++) await r.click(correct.nth(i), { after: 350 });
  await r.click(page.getByRole('button', { name: 'Save decisions' }), { nav: true, after: 1500 });
  await r.scrollBy(520, 1600);
  r.cue('Verified answers flow straight into your results');
  await r.wait(3200);
  return r.stop();
}

module.exports = async function record() {
  await phonePart();
  const { recordId, answers } = await waitForAnalysis();
  console.log(`AI filled ${answers} answers on record ${recordId}`);
  await reviewPart(recordId);
  await excludeDemoEntry(recordId);
};

/**
 * The demo entry is new video evidence, which would make the approved Video
 * Summary stale. Exclude it with the app's record-review action, as a
 * researcher would a test entry.
 */
async function excludeDemoEntry(recordId) {
  const { chromium } = require('playwright');
  const { CHROME } = require('../config');
  const browser = await chromium.launch({ executablePath: CHROME });
  const context = await browser.newContext();
  await staffLogin(await context.newPage());
  await context.request.post(`${BASE}/admin/studies/1/research/record-review`, { form: { record_id: String(recordId), status: 'excluded', reason: 'Demo recording for the AI-assisted entry video' }, maxRedirects: 0 });
  await browser.close();
}
module.exports.parts = ['ai-entry-phone', 'ai-entry-review'];
module.exports.reviewPart = reviewPart;
module.exports.waitForAnalysis = waitForAnalysis;

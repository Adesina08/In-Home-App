const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inicio-reel-test-'));
process.env.UPLOAD_DIR = dir;
process.env.STORAGE_PROVIDER = 'local';
const ffmpeg = require('ffmpeg-static');
const reelSettings = require('../lib/reelSettings');
const { planReel, renderReel, assColor, captionFor } = require('../lib/videoReel');

const summary = () => ({
  evidence: [
    { clip_id: 'V1', file_path: '/uploads/source.mp4', respondent: 'Respondent 1', respondent_id: 7, day: '2026-09-06', shareable: true, duration: 6,
      moments: [{ id: 'V1M1', kind: 'speech', start: 1, end: 2.5, text: 'I always drink Maltina at lunch' }, { id: 'V1M2', kind: 'speech', start: 3.5, end: 4.5, text: 'It tastes sweet' }] },
  ],
  points: [
    { point: 'Malt drinks are a lunchtime habit', respondents: [7], respondent_base: 1, supports: ['V1M1', 'V1M2'],
      clips: [{ clip_id: 'V1', moment_id: 'V1M1', start: 0, end: 6 }, { clip_id: 'V1', moment_id: 'V1M2', start: 3, end: 5 }] },
  ],
});

before(() => {
  const run = (...args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  run('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(dir, 'source.mp4'));
  run('-f', 'lavfi', '-i', 'color=c=red:s=200x100', '-frames:v', '1', path.join(dir, 'logo.png'));
  run('-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', path.join(dir, 'music.wav'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('settings are normalised: unknown values fall back, numbers are bounded', () => {
  const s = reelSettings.normalize({ format: 'cinema', brand: { background: 'red', text: '#ffffff' }, music: { volume: 400 }, captions: { fields: ['day', 'phone'] }, length: { max_total_seconds: 5, title_seconds: 99 } });
  assert.equal(s.format, 'landscape');
  assert.equal(s.brand.background, reelSettings.DEFAULTS.brand.background);
  assert.equal(s.brand.text, '#FFFFFF');
  assert.equal(s.music.volume, 100);
  assert.deepEqual(s.captions.fields, ['day']);
  assert.equal(s.length.max_total_seconds, 15);
  assert.equal(s.length.title_seconds, 15);
});

test('form posts record unticked boxes and a reel without its own settings uses the study defaults', () => {
  const s = reelSettings.fromForm({ format: 'portrait', brand_logo: '0', captions_subtitles: ['0', '1'], captions_fields: 'location', music_enabled: '0', length_max_clips_per_finding: '' });
  assert.equal(s.format, 'portrait');
  assert.equal(s.brand.logo, false);
  assert.equal(s.captions.subtitles, true);
  assert.deepEqual(s.captions.fields, ['location']);
  assert.equal(s.length.max_clips_per_finding, null);
  const study = { reel_settings_json: JSON.stringify({ format: 'square' }), reel_logo_path: '/uploads/logo.png' };
  assert.equal(reelSettings.effective(study, null).settings.format, 'square');
  assert.equal(reelSettings.effective(study, null).inherited, true);
  assert.equal(reelSettings.effective(study, { format: 'portrait' }).settings.format, 'portrait');
  assert.equal(reelSettings.effective(study, { format: 'portrait' }).logoPath, '/uploads/logo.png');
});

test('the plan applies captions, subtitles, intro/outro and per-finding clip limits', () => {
  const settings = reelSettings.normalize({ brand: { intro_title: 'Malt study', outro_text: 'Prepared by INICIO' }, captions: { subtitles: false, fields: ['respondent', 'age', 'location'] }, length: { max_clips_per_finding: 1 } });
  const profiles = new Map([[7, { age_band: '25–34', gender: 'Female', location: 'Lagos' }]]);
  const plan = planReel(summary(), 'Study', { settings, profiles });
  assert.deepEqual(plan.map((s) => s.kind), ['title', 'title', 'clip', 'title']);
  assert.equal(plan[0].title, 'Malt study');
  assert.equal(plan[3].title, 'Prepared by INICIO');
  assert.equal(plan[2].caption, 'Respondent 1 · 25–34 · Lagos');
  assert.deepEqual(plan[2].subtitles, []);
});

test('clips are trimmed only around their supporting moment, and a total length keeps first clips first', () => {
  const trimmed = planReel(summary(), 'Study', { settings: { length: { max_clip_seconds: 3 } } });
  const first = trimmed.find((s) => s.kind === 'clip');
  assert.ok(first.end - first.start <= 3.0001);
  assert.ok(first.start <= 1 && first.end >= 2.5, 'the supporting moment is kept whole');
  const budget = planReel(summary(), 'Study', { settings: { length: { max_total_seconds: 15, title_seconds: 4 } } });
  assert.equal(budget.filter((s) => s.kind === 'clip').length, 1, 'only one clip fits after the title cards');
});

test('captions skip unrecorded profile values and colours convert to libass order', () => {
  assert.equal(captionFor({ respondent: 'Respondent 2', day: 'Mon' }, { gender: 'Not recorded', location: 'Abuja' }, ['respondent', 'gender', 'location']), 'Respondent 2 · Abuja');
  assert.equal(assColor('#1F2A44'), '&H00442A1F');
});

test('a vertical reel renders with logo, logo watermark and ducked music', { timeout: 120000 }, async () => {
  const settings = reelSettings.normalize({ format: 'portrait', brand: { logo: true, logo_on_clips: true, outro_text: 'Thanks' }, music: { enabled: true, volume: 40, duck: true }, length: { title_seconds: 2 } });
  const plan = planReel(summary(), 'Study', { settings });
  const reel = await renderReel(plan, { settings, logoPath: '/uploads/logo.png', musicPath: '/uploads/music.wav' });
  try {
    const info = (() => { try { execFileSync(ffmpeg, ['-hide_banner', '-i', reel.file]); } catch (e) { return String(e.stderr); } })();
    assert.match(info, /720x1280/);
    assert.match(info, /Audio: aac/);
    assert.ok(reel.seconds > 8 && reel.seconds < 20, `unexpected length ${reel.seconds}`);
  } finally {
    reel.cleanup();
  }
});

test('a total length that also fits the second clip keeps it', () => {
  // intro 3s + finding card 3s + 6s clip + 2s clip = 14s.
  const plan = planReel(summary(), 'Study', { settings: { length: { max_total_seconds: 15, title_seconds: 3 } } });
  assert.equal(plan.filter((s) => s.kind === 'clip').length, 2);
});

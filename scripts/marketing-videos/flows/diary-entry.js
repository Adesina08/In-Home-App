// Video: Logging a diary entry (phone-sized web app), with a live camera photo.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Recorder } = require('../rec');
const { DB, WORK, FFMPEG } = require('../config');

/** A slow push-in on a real (stock, unbranded) drink photo, played to Chrome as the phone camera. */
function cameraFeed() {
  const out = path.join(WORK, 'camera.mjpeg');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-i', path.join(WORK, 'stock', 'picked', 'photo-2741251.jpg'), '-t', '6', '-r', '15',
    '-vf', "scale=-2:1080,crop=810:1080,scale=720:960,zoompan=z='1+0.0008*on':d=1:s=720x960:fps=15,format=yuvj420p", '-q:v', '3', out]);
  return out;
}

module.exports = async function record() {
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const person = db.collections.respondents.find((r) => r.name === 'Blessing Adeyemi');
  const r = new Recorder('diary-entry', { width: 390, height: 844, mobile: true, scale: 2, camera: cameraFeed() });
  const page = await r.open();
  await r.goto(`/r/${person.unique_token}`);
  const pick = (value) => page.locator(`input[value="${value}"]`).first();

  await r.start();
  r.cue('Their diary, on their phone', 'Simple, guided, any time of day');
  await r.wait(3000);
  await r.click(page.getByText('Log consumption').first(), { nav: true, after: 900 });

  r.cue('Log a moment in seconds', 'Answer a few questions — or just record a video');
  await r.wait(1600);
  await r.click(page.locator('a:has-text("Standard")'), { nav: true, after: 900 });

  r.cue('Quick, tap-to-answer questions');
  await r.click(pick('Breakfast'), { after: 400 });
  await r.click(pick('Sunrise Malt'), { after: 400 });
  await r.click(pick('Home'), { after: 400 });
  await r.click(pick('Family'), { after: 400 });
  await r.type('input[type=number]', '1', { delay: 120 });

  r.cue('In their own words', 'Open answers feed themes and sentiment');
  await r.type('textarea', 'My kids ask for it every morning before school.', { delay: 38 });
  await r.click(pick('Supermarket'), { after: 500 });

  r.cue('Photo evidence, captured live', 'No old gallery pictures allowed');
  await r.click(page.getByText('Tap to open camera').first(), { after: 2200 });
  await r.click('#camShutterBtn', { after: 1400 });
  await r.click('#camUseBtn', { after: 1400 });

  r.cue('Submitted — quality checks run instantly');
  await r.click(page.locator('button[name=_action][value=submit]').filter({ visible: true }).first(), { nav: true, after: 2600 });
  await r.wait(1500);
  return r.stop();
};

// Video: Fieldwork & recruitment. Part 1 (desktop): staff assign an interviewer,
// plan a household visit, share the self-recruitment link/QR and bulk-invite a
// list. Part 2 (phone): the interviewer screens, consents and registers a
// respondent, then completes training and handover.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { Recorder, staffLogin, BASE } = require('../rec');
const { DB, WORK, FFMPEG, CHROME } = require('../config');

async function staffPart() {
  const r = new Recorder('fieldwork-staff', { width: 1440, height: 900, scale: 1.334 });
  const page = await r.open();
  await staffLogin(page);
  const assignment = page.locator('form[action$="/research/assignment"]');
  const visit = page.locator('form[action$="/research/visit"]');
  const backTo = async (target) => {
    await target.waitFor();
    await r.wait(700);
    await target.evaluate((e) => window.scrollTo(0, window.scrollY + e.getBoundingClientRect().top - 140));
    await r.wait(150);
    await r.resume();
  };
  await r.goto('/admin?study=1#fieldwork-operations');
  await backTo(assignment);

  await r.start();
  r.cue('Run fieldwork from one console', 'Interviewers, areas and household visits');
  await r.wait(1500);
  await r.select(assignment.locator('select[name=user_id]'), '2');
  await r.type(assignment.locator('input[name=area]'), 'Surulere', { delay: 60 });
  await r.type(assignment.locator('input[name=household_target]'), '20', { delay: 90 });
  await r.save(assignment.locator('button[type=submit], button').last());
  await backTo(visit);

  r.cue('Plan household visits', 'Interviewers see them on their phone');
  await r.select(visit.locator('select[name=user_id]'), '2');
  await r.type(visit.locator('input[name=household_code]'), 'HH-0142', { delay: 60 });
  await r.type(visit.locator('input[name=address]'), '14 Adeniran Ogunsanya St, Surulere', { delay: 35 });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await visit.locator('input[name=visit_date]').fill(tomorrow);
  await r.wait(500);
  await r.save(visit.locator('button[type=submit], button').last());
  await backTo(visit);
  await r.wait(1500);

  await r.goto('/admin/studies/1/respondents');
  r.cue('Or let people sign themselves up', 'One study link and QR code — print it, post it, share it');
  await r.click(page.getByText('Invite respondents & access recruitment links'), { after: 900 });
  await r.scrollTo(page.getByText('Respondent QR code').first(), { offset: 140 });
  await r.wait(2800);

  await r.goto('/admin/studies/1/bulk-invite');
  r.cue('Invite a whole list at once', 'Upload a spreadsheet of names and numbers');
  await r.wait(1500);
  const file = page.locator('input[type=file]');
  await r.moveTo(page.locator('form[action$="/bulk-invite/review"]'), 700);
  await file.setInputFiles(path.join(WORK, 'roster.csv'));
  await r.wait(800);
  await r.click(page.locator('form[action$="/bulk-invite/review"] button').last(), { nav: true, after: 1200 });
  r.cue('Every row checked before anything is sent', 'Duplicates and bad numbers caught for you');
  await r.scrollBy(300, 1500); await r.wait(2200);
  await r.click(page.getByRole('button', { name: /Invite \d+ people/ }), { nav: true, after: 1500 });
  r.cue('Invitations on their way');
  await r.wait(2500);
  return r.stop();
}

/** The respondent's own practice entry, done through their personal link (needed before handover). */
async function practiceEntry(token) {
  const camera = path.join(WORK, 'camera.mjpeg');
  if (!fs.existsSync(camera)) {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-i', path.join(WORK, 'stock', 'picked', 'photo-2741251.jpg'), '-t', '6', '-r', '15',
      '-vf', 'scale=-2:1080,crop=810:1080,scale=720:960,format=yuvj420p', '-q:v', '3', camera]);
  }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camera}`] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] })).newPage();
  await page.goto(`${BASE}/r/${token}/diary/new?mode=standard&practice=1`, { waitUntil: 'networkidle' });
  for (const v of ['Snack', 'Sunrise Malt', 'Home', 'Supermarket']) await page.locator(`input[value="${v}"]`).first().check();
  await page.fill('input[type=number]', '1');
  await page.getByText('Tap to open camera').first().click(); await page.waitForTimeout(1800);
  await page.click('#camShutterBtn'); await page.waitForTimeout(800); await page.click('#camUseBtn'); await page.waitForTimeout(800);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.locator('button[name=_action][value=submit]').filter({ visible: true }).first().click()]);
  await browser.close();
}

async function interviewerPart() {
  const r = new Recorder('fieldwork-interviewer', { width: 390, height: 844, mobile: true, scale: 2 });
  const page = await r.open();
  await staffLogin(page, 'interviewer@inicio.demo');
  await r.goto('/interviewer');

  await r.start();
  r.cue('Interviewers recruit face to face', 'Their own portal, on their phone');
  await r.wait(1800);
  await r.scrollTo(page.getByText('My household visits').first(), { offset: 90 });
  await r.wait(2000);
  await r.goto('/interviewer/register');
  r.cue('Screen eligibility on the spot', 'Your study screener, answer by answer');
  await r.scrollTo(page.locator('select[name="screener[age_band]"]'), { offset: 220 });
  for (const [code, value] of [['age_band', 'Yes'], ['malt_drinker', 'Yes'], ['industry', 'No']]) await r.select(page.locator(`select[name="screener[${code}]"]`), value);
  r.cue('Consent recorded with the respondent', 'Including permission to share photos and video');
  await r.click('input[name=consent_given]', { after: 500 });
  await r.click('input[name=media_consent]', { after: 500 });
  await r.type('input[name=name]', 'Kemi Adewale', { delay: 55 });
  await r.type('input[name=contact]', '0805 777 8812', { delay: 70 });
  await r.click(page.getByText('Register & continue'), { nav: true, after: 1200 });

  r.cue('Train them, then hand over', 'A practice entry on their own phone comes first');
  const id = page.url().match(/respondents\/(\d+)/)[1];
  await r.click('input[name=training_complete]', { after: 500 });
  await r.save(page.getByRole('button', { name: 'Save training completion' }));
  // The respondent's practice entry happens on their own phone; it is not part of this screen.
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  await practiceEntry(db.collections.respondents.find((x) => x._id === Number(id)).unique_token);
  await page.reload({ waitUntil: 'networkidle' });
  await r.resume();
  await r.wait(1200);
  await r.click(page.getByRole('button', { name: /Verify practice/ }), { nav: true, after: 1500 });
  r.cue('Handover complete — their diary is live');
  await r.wait(1500);
  await r.scrollBy(380, 1600); await r.wait(2500);
  return r.stop();
}

module.exports = async function record() {
  await staffPart();
  await interviewerPart();
};
module.exports.staffPart = staffPart;
module.exports.interviewerPart = interviewerPart;

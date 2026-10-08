// Video: Respondent onboarding (phone-sized web app), from invite link to a ready account.
const fs = require('fs');
const { Recorder, latestCode } = require('../rec');
const { DB } = require('../config');

module.exports = async function record() {
  // An invited respondent from the base demo seed; read from the demo database file.
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const person = (db.collections.respondents || []).find((r) => r.name === 'Amaka Obi' && r.activation_status === 'invited');
  if (!person) throw new Error('No fresh invited respondent: run ./reset.sh first.');

  const r = new Recorder('respondent-onboarding', { width: 390, height: 844, mobile: true, scale: 2 });
  const page = await r.open();
  await r.goto(`/invite/${person.unique_token}`);

  await r.start();
  r.cue('Respondents join from one link', 'Sent by WhatsApp, SMS or email');
  await r.wait(3200);
  await r.click(page.getByText('Read study consent'), { nav: true, after: 900 });

  r.cue('Clear consent, in plain words');
  await r.scrollBy(260, 1200); await r.wait(1200);
  await r.click('input[name=agree]', { after: 600 });
  await r.click(page.getByText('I agree — continue'), { nav: true, after: 900 });

  r.cue('A quick pre-survey', 'Details checked before the diary starts');
  await r.wait(1800);
  await r.click(page.locator('button:has-text("Continue")'), { nav: true, after: 900 });

  r.cue('Phone verified with a one-time code');
  await r.click(page.getByText('Send verification code'), { nav: true, after: 1200 });
  await r.type('input[name=code]', latestCode(), { delay: 140 });
  await r.click(page.getByText('Verify and continue'), { nav: true, after: 900 });

  r.cue('A short profile', 'For richer, segmented analysis');
  await r.type('input[name=location]', 'Surulere, Lagos', { delay: 45 });
  await r.type('input[name=age]', '31', { delay: 90 });
  for (const [name, label] of [['gender', 'Female'], ['occupation', null], ['marital_status', 'Married']]) {
    const sel = page.locator(`select[name=${name}]`);
    const value = await sel.evaluate((s, label) => [...s.options].find((o) => (label ? o.text === label : o.index === 3))?.value || s.options[1].value, label);
    await r.select(sel, value);
  }
  // Remaining optional fields filled off-camera so the form submits cleanly.
  for (const name of ['education_level', 'religion']) {
    await page.locator(`select[name=${name}]`).evaluate((s) => { s.value = s.options[1].value; });
  }
  await r.click('input[name=recontact_consent][value=yes]', { after: 500 });
  await r.click(page.getByText('Save profile & continue'), { nav: true, after: 1000 });

  r.cue('Their choice: app or WhatsApp');
  await r.scrollBy(380, 1300); await r.wait(1600);
  await r.click(page.locator('button:has-text("Use the INICIO Diary Mobile App")'), { nav: true, after: 900 });

  r.cue('A private login in seconds');
  await r.type('input[name=username]', 'amaka.obi');
  await r.type('#password', 'Malt-Moments-2026', { delay: 40 });
  await r.type('#confirm_password', 'Malt-Moments-2026', { delay: 40 });
  await r.click(page.getByText('Create account and continue'), { nav: true, after: 1200 });

  r.cue('Ready to start their diary');
  await r.wait(1500);
  await r.scrollBy(420, 1500); await r.wait(2200);
  return r.stop();
};

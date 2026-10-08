// Video: Study creation (staff console, desktop).
const { Recorder, staffLogin } = require('../rec');

module.exports = async function record() {
  const r = new Recorder('study-creation', { width: 1440, height: 900, scale: 1.334 });
  const page = await r.open();
  await staffLogin(page);
  await r.goto('/admin/studies');

  await r.start();
  r.cue('All your studies in one place');
  await r.wait(2200);

  await r.click('[data-open-dialog="create-study"]', { after: 700 });
  // Categories start all ticked; clear them so we tick just the one we need on camera.
  await page.$$eval('#create-study input[name=category]', (els) => els.forEach((e) => { e.checked = false; }));
  r.cue('Create a study in seconds', 'Name, market and product category');
  await r.type('#create-study input[name=name]', 'Breakfast Cereal Diary · Abuja');
  await r.select('#create-study select[name=market_country_code]', 'NG');
  await r.click(page.locator('#create-study label').filter({ hasText: 'Breakfast Cereal' }), { after: 500 });
  await r.select('#create-study select[name=diary_mode]', 'daily');
  r.cue('Choose how often respondents log', 'Daily, weekly or on every occasion');
  await r.wait(900);
  await r.click(page.locator('#create-study').getByRole('button', { name: 'Create Study', exact: true }), { nav: true, after: 1200 });

  r.cue('Set the rules once', 'Evidence, quality checks and reminders');
  await r.scrollBy(520, 1400); await r.wait(900);
  await r.scrollBy(620, 1400); await r.wait(900);
  await r.scrollBy(-1140, 1000);

  await r.click(page.getByRole('link', { name: 'Questionnaire' }).first(), { nav: true, after: 900 });
  r.cue('Build your questionnaire', 'Type it in, or import it from Excel');
  await r.moveTo(page.getByText('Import', { exact: true }).first(), 800); await r.wait(900);
  await r.click('#addQuestion', { after: 900 });
  await r.type('#fText', 'Which cereal brand did you have?');
  await page.locator('#fText').blur(); await r.wait(600);
  await r.select('#fType', 'single'); await r.wait(900);
  for (const [i, name] of ['Crunchy Oats', 'Golden Flakes', 'Morning Puffs'].entries()) {
    await r.click('#addOpt', { after: 700 });
    const inp = page.locator('.opt-in').nth(i);
    await r.type(inp, name, { delay: 45 });
    await inp.blur(); await r.wait(500);
  }
  r.cue('Photo, video and voice-note questions', 'Evidence straight from the home');
  await r.scrollBy(-400, 600);
  await r.click('#addQuestion', { after: 900 });
  await r.type('#fText', 'Take a photo of your breakfast bowl');
  await page.locator('#fText').blur(); await r.wait(500);
  await r.select('#fType', 'photo'); await r.wait(900);

  r.cue('Preview exactly what respondents see');
  await r.click('#openPreview', { after: 4200 });
  await page.keyboard.press('Escape').catch(() => {});
  await r.wait(600);

  await r.goto(page.url().replace(/\/questionnaire.*$/, '/respondents'));
  r.cue('Invite respondents', 'By WhatsApp, SMS or email');
  await r.click(page.getByText('Invite respondents & access recruitment links'), { after: 900 });
  await r.type('input[name=contact]', '0803 456 7812');
  await r.type('form[action$="/respondents/invite"] input[name=name]', 'Halima Sani');
  await r.wait(600);
  await r.click(page.locator('form[action$="/respondents/invite"] button').first(), { nav: true, after: 2200 });
  r.cue('Ready for fieldwork');
  await r.wait(2400);
  return r.stop();
};

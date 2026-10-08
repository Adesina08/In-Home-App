// Video: Rewards. Part 1 (desktop): staff set reward milestones, the celebration
// and pay a reward through the finance ledger. Part 2 (phone): the respondent's
// real mobile app (web export, see serve-mobile.js) celebrates and shows progress.
const { Recorder, staffLogin } = require('../rec');

const MOBILE = 'http://localhost:8090/';

async function staffPart() {
  const r = new Recorder('rewards-staff', { width: 1440, height: 900, scale: 1.334 });
  const page = await r.open();
  await staffLogin(page);
  const panel = page.locator('details:has(summary:has-text("Reward milestones and payments"))');
  // Each save reloads the page at the top with the panel closed. The reload is
  // cut from the video: capture pauses on submit and resumes once back in place.
  const openRewards = async (scrollTo) => {
    await panel.waitFor();
    await r.wait(800); // let the browser's own jump to #fieldwork-operations finish first
    if (!(await panel.evaluate((d) => d.open))) await panel.evaluate((d) => { d.open = true; });
    await r.wait(200);
    const target = scrollTo || panel;
    await target.waitFor();
    await target.evaluate((e) => window.scrollTo(0, window.scrollY + e.getBoundingClientRect().top - 110));
    await r.wait(150);
    await r.resume();
  };
  await r.goto('/admin?study=1#fieldwork-operations');
  await openRewards();

  await r.start();
  r.cue('Reward respondents for real participation', 'Set milestones in your own currency');
  await r.wait(1800);
  const rule = page.locator('form[action$="/incentive-rule"]');
  for (const [milestone, periods, amount] of [['onboarding', '', '500'], ['participation', '7', '2000'], ['closeout', '', '5000']]) {
    await r.select(rule.locator('select[name=milestone]'), milestone);
    if (periods) await r.type(rule.locator('input[name=required_periods]'), periods, { delay: 90 });
    await r.type(rule.locator('input[name=amount]'), amount, { delay: 80 });
    await r.type(rule.locator('input[name=currency]'), 'NGN', { delay: 80 });
    await r.save(rule.getByRole('button', { name: 'Add reward' }));
    await openRewards(page.locator('form[action$="/incentive-rule"]'));
  }
  r.cue('Getting started, 7 diary days, and a completion bonus');
  await r.wait(2400);

  r.cue('Design the celebration they will see', 'Your headline, message and colours');
  const celebration = page.locator('form[action$="/reward-settings"]');
  await r.scrollTo(celebration, { offset: 130 });
  await r.type(celebration.locator('input[name=headline]'), 'Well done — reward unlocked!', { delay: 40 });
  await r.save(celebration.getByRole('button', { name: 'Save celebration' }));
  await openRewards(page.getByRole('button', { name: 'Refresh eligibility' }));

  r.cue('Eligibility checked automatically', 'Only valid, quality-checked diary days count');
  await r.save(page.getByRole('button', { name: 'Refresh eligibility' }));
  const adaeze = page.locator('div.rounded-xl.border').filter({ hasText: 'Adaeze Okafor' }).filter({ has: page.locator('select[name=payment_method]') }).first();
  await openRewards(adaeze);
  await r.wait(1800);

  r.cue('Send to finance in one step', 'Bank transfer, airtime, voucher or cash');
  await r.select(adaeze.locator('select[name=payment_method]'), 'airtime');
  await r.type(adaeze.locator('input[name=finance_note]'), 'MTN airtime to registered number', { delay: 35 });
  await r.save(adaeze.getByRole('button', { name: 'Send to finance' }));
  const processing = page.locator('div.rounded-xl.border').filter({ hasText: 'Adaeze Okafor' }).filter({ has: page.locator('input[name=reference]') }).first();
  await openRewards(processing);

  r.cue('Every payment recorded with a reference');
  await r.type(processing.locator('input[name=reference]'), 'AIRTIME-NG-48213', { delay: 60 });
  await r.save(processing.getByRole('button', { name: 'Confirm paid' }));
  await openRewards(page.getByText(/reference AIRTIME-NG-48213/).first());
  await r.wait(2800);
  return r.stop();
}

async function appPart() {
  const r = new Recorder('rewards-app', { width: 390, height: 844, mobile: true, scale: 2 });
  const page = await r.open();
  await page.goto(MOBILE, { waitUntil: 'networkidle' });
  await r.wait(1500);

  await r.start();
  r.cue('Respondents see rewards in their app');
  await r.type(page.locator('input').nth(0), 'demo', { delay: 70 });
  await r.type(page.locator('input').nth(1), 'Demo1234!', { delay: 70 });
  await r.click(page.getByText('Open my diary'), { after: 1500 });
  r.cue('A celebration the moment a reward is earned');
  await page.getByText('Well done — reward unlocked!').waitFor({ timeout: 20000 });
  await r.wait(4500);
  r.cue('Clear progress to every milestone', 'Earned, in progress and paid, at a glance');
  await r.click(page.getByText('View my rewards').first(), { after: 1800 });
  await r.scrollBy(320, 1800); await r.wait(1600);
  await r.scrollBy(320, 1800); await r.wait(2200);
  return r.stop();
}

module.exports = async function record() {
  await staffPart();
  await appPart();
};
module.exports.staffPart = staffPart;
module.exports.appPart = appPart;

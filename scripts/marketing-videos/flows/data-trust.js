// Video: Data you can trust (staff console, desktop): automatic quality flags,
// evidence review with an audit note, follow-up calls, respondent risk,
// versioned consent and client data permissions.
const { Recorder, staffLogin } = require('../rec');

module.exports = async function record() {
  const r = new Recorder('data-trust', { width: 1440, height: 900, scale: 1.334 });
  const page = await r.open();
  await staffLogin(page);
  await r.goto('/admin/qc?study=1');

  await r.start();
  r.cue('Every entry checked automatically', 'Duplicates, bursts, late entries and missing evidence');
  await r.wait(2500);
  // Open a duplicate-answers flag from the review queue.
  await r.click(page.locator('a, button').filter({ hasText: /duplicate repetitive/i }).first(), { nav: true, after: 1200 });
  r.cue('Reviewers see the evidence side by side', 'Photo, answers and the reason it was flagged');
  await r.wait(1800);
  await r.scrollBy(300, 1600); await r.wait(1200);
  await r.scrollBy(-300, 1000);
  r.cue('Every decision is recorded', 'With a note, a name and a timestamp');
  await r.type('textarea[name=action_note]', 'Called respondent: two similar dinners on consecutive days, genuine. Keeping both.', { delay: 28 });
  await r.click(page.locator('button[name=status][value=resolved]'), { nav: true, after: 1500 });
  await r.wait(1200);

  await r.click(page.getByText('Exception follow-up').first(), { nav: true, after: 1200 });
  r.cue('Unresolved issues become a call list', 'So nobody falls through the cracks');
  await r.wait(1800);
  const call = page.locator('form[action$="/follow-up"]').first();
  await r.select(call.locator('select[name=outcome]'), 'reached_resolved');
  await r.type(call.locator('[name=notes]'), 'Reached by phone. Back entry was a forgotten weekend snack; confirmed.', { delay: 28 });
  await r.click(call.getByRole('button', { name: 'Log call' }), { nav: true, after: 1500 });
  await r.wait(1200);

  await r.goto('/admin/studies/1/respondents/8');
  r.cue('A risk score for every respondent', 'Green, amber or red, with the history behind it');
  await r.wait(2200);
  await r.scrollBy(280, 1600); await r.wait(2000);

  await r.goto('/admin/studies/1/consent');
  r.cue('Consent is versioned and approved', 'Respondents always see the approved wording');
  await r.wait(1500);
  const draft = page.locator('textarea[name=body]');
  await r.scrollTo(draft, { offset: 200 });
  await r.type(draft, 'Thank you for joining the Malt Moments Diary. For two weeks, record each malt drink with a few quick questions and a photo. '
    + 'Your answers are used only for research and never shared with your name. You can stop at any time and keep the rewards you have earned.', { delay: 6 });
  await r.click(page.getByRole('button', { name: 'Save as draft' }), { nav: true, after: 1200 });
  r.cue('A new version, approved with one click', 'The full history is kept');
  await r.click(page.locator('summary').filter({ hasText: 'Draft' }).first(), { after: 800 });
  await r.click(page.getByRole('button', { name: 'Approve this version' }).first(), { nav: true, after: 1500 });
  await r.scrollTo(page.getByText('Version history').first(), { offset: 140 });
  await r.wait(2200);

  await r.goto('/admin/studies/1/kpis');
  const access = page.locator('form[action$="/research/grant"]');
  await r.scrollTo(access, { offset: 160 });
  r.cue('You decide what each client sees', 'Photos and video, open answers, exports — per client');
  const clientSelect = access.locator('select[name=user_id]');
  const clientValue = await clientSelect.evaluate((s) => [...s.options].find((o) => o.value && /client/i.test(o.text))?.value);
  await r.select(clientSelect, clientValue);
  for (const name of ['media', 'text', 'exports']) {
    const box = access.locator(`input[name=${name}]`);
    if (!(await box.isChecked())) await r.click(box, { after: 400 });
  }
  await r.click(access.getByRole('button', { name: 'Save client permissions' }), { nav: true, after: 1500 });
  r.cue('Saved — the client portal follows these rules', 'And small groups are always hidden from clients');
  await r.wait(2800);
  return r.stop();
};

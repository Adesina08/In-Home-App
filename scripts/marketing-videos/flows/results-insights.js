// Video: Results & insights (staff console, then the client portal; desktop).
const { Recorder, staffLogin, BASE } = require('../rec');

module.exports = async function record() {
  const r = new Recorder('results-insights', { width: 1440, height: 900, scale: 1.334 });
  const page = await r.open();
  await staffLogin(page);
  // Open the AI Summary page off camera first: if new entries made the saved
  // summary stale, the page regenerates it, and that should not be on screen.
  await r.goto('/admin/ai-summary?study=1');
  for (let i = 0; i < 24 && await page.getByText(/Generating with/).count(); i++) { await r.wait(5000); await r.goto('/admin/ai-summary?study=1'); }
  await r.goto('/admin?study=1');

  await r.start();
  r.cue('Live fieldwork at a glance', 'Participation, recruitment and quality in one view');
  await r.wait(3000);
  await r.scrollBy(380, 1500); await r.wait(1500);

  await r.scrollTo(page.getByText('Turn occasions into understanding.'));
  r.cue('Charts that build themselves', 'From every validated diary answer');
  await r.wait(2200);
  await r.scrollBy(420, 1500); await r.wait(2000);
  await r.scrollTo(page.getByText('Compare consumer groups').first());
  r.cue('Compare consumer groups', 'Crosstabs by gender, age and location');
  await r.wait(3200);

  await r.click(page.getByRole('link', { name: 'Quality Control' }).first(), { nav: true, after: 900 });
  r.cue('Quality checks, built in', 'Duplicates, bursts and late entries flagged automatically');
  await r.wait(3200);

  await r.click(page.getByRole('link', { name: 'AI Summary' }).first(), { nav: true, after: 900 });
  r.cue('An AI-written study summary', 'Grounded in your figures — reviewed before sharing');
  await r.scrollTo(page.getByText('Executive summary').first(), { offset: 90 });
  await r.wait(2500);
  await r.scrollBy(300, 2600); await r.wait(1500);
  await r.scrollTo(page.getByText('Word cloud').first(), { offset: 90 });
  r.cue('Hear respondents in their own words', 'Word clouds from answers and transcripts');
  await r.wait(3000);
  await r.scrollTo(page.getByText('Respondent media').first(), { offset: 90 });
  // Gallery videos load lazily; show their first frame instead of a black tile.
  await page.$$eval('.report-media video', (vs) => vs.forEach((v) => { v.preload = 'auto'; v.muted = true; v.currentTime = 1; }));
  r.cue('Every photo and video, in one place');
  await r.wait(1800);
  await r.scrollBy(320, 2200); await r.wait(1500);

  // Video Summary: AI watches every respondent video; the reviewed reel plays here.
  await r.click(page.getByRole('link', { name: 'Video Summary' }).first(), { nav: true, after: 900 });
  r.cue('Every respondent video, watched by AI', 'Findings linked to the exact moments that support them');
  const reel = page.locator('video').first();
  await r.scrollTo(reel, { offset: 140 });
  await reel.evaluate((v) => { v.muted = true; v.currentTime = 0; return v.play(); });
  await r.wait(9000);
  r.cue('A highlight reel, ready for the debrief', 'Real moments, captioned from what people said');
  await r.wait(7000);
  await reel.evaluate((v) => v.pause());
  await r.scrollTo(page.getByText('Malt is part of family rituals').nth(1), { offset: 160 });
  r.cue('Every finding backed by a real quote');
  await r.wait(2500);
  await r.scrollBy(420, 2200); await r.wait(1500);

  // Switch to the client's view: sign out and in as the client on camera.
  r.cue('Your clients get their own portal', 'Approved results only — never raw personal data');
  await r.goto('/logout');
  await r.click(page.getByText('Proceed to login'), { after: 600 });
  await r.type('#email', 'client@inicio.demo', { delay: 35 });
  await r.type('input[name=password]', 'Demo1234!', { delay: 35 });
  await r.click('button[type=submit]', { nav: true, after: 1500 });
  if (!page.url().includes('/client')) await r.goto('/client?study=1');
  await r.wait(1800);
  await r.scrollBy(520, 1800); await r.wait(1500);
  await r.scrollTo(page.getByText('Study summary').first(), { offset: 90 });
  await r.wait(2500);
  const clientReel = page.locator('section:has-text("What respondents showed us on video") video').first();
  await r.scrollTo(page.getByText('What respondents showed us on video'), { offset: 90 });
  r.cue('Approved video stories, ready to share');
  await clientReel.evaluate((v) => { v.muted = true; v.currentTime = 12; return v.play(); });
  await r.wait(6000);
  await clientReel.evaluate((v) => v.pause());
  return r.stop();
};

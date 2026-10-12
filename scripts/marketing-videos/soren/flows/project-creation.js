// Video: creating a real project on Soren: basic details, a questionnaire level uploaded
// from a Word file, an AI discussion-guide level, pre-survey, facilitators.
// DRY=1 rehearses everything except the final "Create project" click.
const path = require('path');
const { ADMIN, DIR, adminRecorder, state } = require('../common');
const { PROJECT, QUESTIONNAIRE_LEVEL, GUIDE_LEVEL, GUIDE } = require('../content');

module.exports = async function record() {
  const r = adminRecorder('soren-project-creation');
  const page = await r.open();
  const button = (name, exact = false) => page.getByRole('button', { name, exact });
  await r.goto(ADMIN + '/projects');
  await page.getByRole('button', { name: 'View Details' }).first().waitFor();

  await r.start();
  r.cue('Every study starts as a project', 'InsightsFlow keeps projects, sessions and participants together');
  await r.wait(2600);
  await r.click(button('Create Project'), { after: 1500 });

  r.cue('Start with the basics', 'A clear title, a real brief and the purpose');
  await r.type('input[name=projectTitle]', PROJECT.title, { delay: 45 });
  await r.type('textarea', PROJECT.description, { delay: 8 });
  await r.click(page.getByText(PROJECT.purpose, { exact: true }));
  await r.click(button('Continue'), { after: 1200 });

  r.cue('Split the study into levels', 'Each level holds a questionnaire or an AI discussion guide');
  await r.type('input[name="levels[0].title"]', QUESTIONNAIRE_LEVEL, { delay: 45 });
  await r.click(button('Add a question'), { after: 1500 });

  r.cue('Already have a questionnaire?', 'Upload the Word or PDF file and AI reads every question');
  await r.click(button('Generate with AI'), { after: 900 });
  await r.click(button('Import from a file'), { after: 900 });
  const dialog = page.getByRole('dialog');
  await r.moveTo(dialog.getByText('Drag & drop your file or browse'));
  await page.evaluate(() => window.__cursor && window.__cursor.pulse());
  await dialog.locator('input[type=file]').setInputFiles(path.join(DIR, 'morning-drink-questionnaire.docx'));
  await page.getByText('Extracting questions').waitFor({ timeout: 10000 }).catch(() => {});
  await r.wait(1800);
  r.pause(); // the extraction wait is cut from the video
  await page.getByText('Extracting questions').waitFor({ state: 'hidden', timeout: 180000 });
  await page.getByText('8 questions Added').waitFor();
  await r.wait(800);
  await r.resume();

  r.cue('Questions, options, sections and skip logic', 'All imported in seconds and ready to edit');
  await r.wait(1800);
  await r.scrollBy(650, 2200);
  await r.wait(900);
  await r.scrollBy(900, 2600);
  await r.wait(900);
  await r.scrollBy(-1550, 1800);
  await r.click(page.getByRole('tab', { name: /Branches/ }).or(button('Branches 1')).first(), { after: 2200 });
  await r.click(button('Save & Publish'), { after: 1500 });

  r.cue('Add an AI-moderated conversation', 'An objective, prompts and follow-up probes');
  await r.click(page.getByText('Level Title', { exact: true }).locator('xpath=..').locator('button').first(), { after: 800 });
  await r.type('input[name="levels[1].title"]', GUIDE_LEVEL, { delay: 45 });
  await r.click(button('Add discussion guide'), { after: 1500 });
  await r.click(button('Add objective'), { after: 700 });
  await r.type('textarea[placeholder^="e.g. Understand why"]', GUIDE.objective, { delay: 10 });
  for (const [i, pr] of GUIDE.prompts.entries()) {
    if (i === 1) r.cue('Mark what must be covered', 'The AI interviewer follows up when answers are thin');
    await r.click(button('Add prompt'), { after: 700 });
    const fast = i > 1; // the first two are typed in full; the rest go in quicker
    await r.type('input[placeholder="e.g. Warm-up"]', pr.section, { delay: fast ? 20 : 45 });
    await r.type('textarea[placeholder="What should the facilitator ask or cover?"]', pr.text, { delay: fast ? 12 : 28 });
    if (pr.mustCover) await r.click(page.getByText('Must cover', { exact: true }), { after: 300 });
    await r.type('input[placeholder="e.g. 5"]', pr.minutes, { delay: 60 });
    if (pr.probe) {
      await r.type('input[placeholder="Add a follow-up probe"]', pr.probe, { delay: fast ? 12 : 28 });
      await r.click(button('Add', true), { after: 500 });
    }
  }
  await r.click(button('Save & Publish'), { after: 1500 });

  r.cue('Two levels, ready to field');
  await r.wait(2000);
  await r.click(button('Continue'), { after: 1200 });

  r.cue('Choose what to learn about each participant', 'Collected once, before the first session');
  for (const item of PROJECT.preSurvey) await r.click(page.getByText(item, { exact: true }), { after: 250 });
  await r.click(button('Continue'), { after: 1200 });

  r.cue('Assign facilitators and recruiters');
  await r.click(page.getByText('Add myself as facilitator'), { after: 500 });
  await r.click(button('Continue'), { after: 1500 });

  // The project is created only once. Re-takes (or DRY=1) show the click, then cut to the
  // project that already exists, so the live system never gets a duplicate.
  const create = button('Create project');
  const { projectId } = state.read();
  if (projectId || process.env.DRY) {
    await r.moveTo(create);
    await page.evaluate(() => window.__cursor && window.__cursor.pulse());
    await r.wait(400);
    if (process.env.DRY) { await r.wait(1200); await r.stop(); return; }
    r.pause();
    await page.goto(ADMIN + '/projects', { waitUntil: 'load' });
  } else {
    await r.click(create, { after: 500 });
    r.pause();
  }
  // Creating returns to the project list, newest first.
  await page.waitForURL('**/projects', { timeout: 60000 });
  const card = page.getByText(PROJECT.title, { exact: true }).first();
  await card.waitFor();
  await r.wait(1200);
  await r.resume();
  r.cue('Project created', 'Live in the project list, ready for sessions');
  await r.wait(2000);
  await r.click(card, { after: 500 });
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/, { timeout: 30000 });
  state.merge({ projectId: page.url().match(/projects\/([0-9a-f-]{36})/)[1], projectUrl: page.url() });
  await page.getByText(PROJECT.title).first().waitFor();
  await r.wait(3500);
  await r.stop();
};

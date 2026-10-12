// Video: Advanced questionnaires (staff console, desktop). Import a whole
// questionnaire with its logic from Excel, inspect skip logic, scoring and
// expressions, build an AND rule on camera, then test it all in the preview.
const fs = require('fs');
const path = require('path');
const { Recorder, staffLogin } = require('../rec');
const { DB, WORK } = require('../config');

module.exports = async function record() {
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const study = db.collections.studies.find((s) => s.name === 'Noodle Moments · Abuja');
  if (!study) throw new Error('No noodle study: run ./reset.sh first.');
  const id = study._id;
  const r = new Recorder('questionnaire-logic', { width: 1440, height: 900, scale: 1.334 });
  const page = await r.open();
  await staffLogin(page);
  await r.goto(`/admin/studies/${id}/questionnaire/upload`);

  await r.start();
  r.cue('Bring your questionnaire from Excel', 'Questions, options and logic in one sheet');
  await r.moveTo(page.getByText(/template/i).first(), 800);
  await r.wait(1200);
  await r.moveTo(page.locator('input[type=file]'), 700);
  await page.locator('input[type=file]').setInputFiles(path.join(WORK, 'noodles-questionnaire.xlsx'));
  await r.wait(700);
  await r.click(page.getByRole('button', { name: /Upload & Parse/ }), { nav: true, after: 1200 });
  r.cue('Check every row before anything changes', 'With a live preview of the respondent screen');
  await r.wait(1500);
  await r.scrollBy(420, 2000); await r.wait(1500);
  await r.click(page.getByText('Commit Checked Rows to Questionnaire'), { nav: true, after: 1500 });
  r.cue('10 questions and their logic, imported', 'Skips, scores, variables and terminations included');
  await r.wait(2000);

  const editQuestion = async (text) => { await r.click(page.locator('aside, nav, div').getByText(text, { exact: false }).first(), { after: 900 }); };
  const logicTab = async (value) => { await r.scrollTo(page.locator('#logicTab'), { offset: 260 }); await r.select('#logicTab', value); await r.wait(900); };

  await editQuestion('Who did you share it with?');
  r.cue('Skip logic per answer', '“Nobody” jumps straight to the rating');
  await logicTab('skip');
  await r.wait(2000);

  await editQuestion('How would you rate your');
  r.cue('Scores add up as people answer', 'And can be piped into later questions');
  await logicTab('scoring');
  await r.wait(2200);

  await editQuestion('What made them poor today?');
  r.cue('Expressions for anything more complex');
  await logicTab('custom');
  await r.wait(2200);

  await editQuestion('How old are the children');
  r.cue('Combine conditions with AND or OR', 'Show this only when both are true');
  await logicTab('showhide');
  await r.select('#rAction', 'show');
  await r.select('#rMatch', 'all');
  const conds = page.locator('#rConds .r-cond');
  if (!(await conds.count())) await r.click('#rAddCond', { after: 500 });
  const q = (text) => page.locator('#rConds .r-cond').last().locator('.r-q').evaluate((s, t) => [...s.options].find((o) => o.text.includes(t))?.value, text);
  await r.select(conds.nth(0).locator('.r-q'), await q('Who did you share it with?'));
  await r.select(conds.nth(0).locator('.r-op'), 'equals');
  await r.type(conds.nth(0).locator('.r-val'), 'Children', { delay: 60 });
  await r.click('#rAddCond', { after: 600 });
  await r.select(conds.nth(1).locator('.r-q'), await q('How many packs'));
  await r.select(conds.nth(1).locator('.r-op'), 'gte');
  await r.type(conds.nth(1).locator('.r-val'), '2', { delay: 90 });
  await r.click('#rSave', { after: 1500 });
  await r.wait(1200);

  r.cue('Test it exactly as respondents will see it');
  await r.scrollBy(-2000, 900);
  await r.click('#openPreview', { after: 2200 });
  const f = page.frameLocator('#previewFrame');
  // The preview scrolls inside the phone frame; glide the question into view.
  const reveal = async (text) => { await f.getByText(text).first().evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' })); await r.wait(1200); };
  const pick = async (value) => { await r.click(f.locator(`input[value="${value}"]`).first(), { after: 450 }); };
  await pick('Yes');
  await pick('Mama Pot');
  r.cue('Answers are piped into later questions', '“What did you add to your Mama Pot noodles?”');
  await pick('Egg'); await pick('Vegetables');
  await r.type(f.locator('input[type=number]').first(), '2', { delay: 120 });
  r.cue('Questions appear only when they apply');
  await pick('Children');
  await reveal('How old are the children');
  r.cue('Children and 2+ packs — so the age question appears', 'Both conditions true (AND)');
  await r.wait(2200);
  await pick('Poor');
  await r.wait(1500);
  r.cue('Score 4 — so the follow-up question appears', 'All live, before you publish');
  await reveal('Nutrition score');
  await r.wait(3000);
  return r.stop();
};

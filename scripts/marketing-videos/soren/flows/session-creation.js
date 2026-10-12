// Video: creating the two sessions of the demo project — Individual Online in Bot Mode
// (the questionnaire level) and in AI Bot Mode (the discussion-guide level) — and copying
// each shareable link. Each session is created once; re-takes cut to the existing one.
const { ADMIN, adminRecorder, state } = require('../common');
const { SESSIONS } = require('../content');

const UUID = /session\/([0-9a-f-]{36})/;

async function createSession(r, page, key, { first }) {
  const s = SESSIONS[key];
  const button = (name, exact = false) => page.getByRole('button', { name, exact });
  const existing = state.read().sessions?.[key];

  await r.click(button('Create Session'), { after: 500 });
  // The form is usable once it has checked the default level for questions.
  await page.getByText('This session will use this level’s questionnaire.').waitFor({ timeout: 60000 });
  await r.wait(1500);
  r.cue(first ? 'Create a session for each level' : 'Now an AI-moderated session',
    first ? 'Pick the format, channel and mode' : 'The AI interviewer follows the discussion guide and probes for depth');
  await r.type('input[placeholder="Session Name"]', s.name, { delay: 50 });
  await r.click(button('Individual', true), { after: 300 });
  await r.click(button('Online', true), { after: 300 });
  await r.click(button(key === 'ai' ? 'AI Bot Mode' : 'Bot Mode', true), { after: 900 });
  if (first) r.cue('Individual Online, Bot Mode', 'Each participant answers the questionnaire through a web link');
  else r.cue('Individual Online, AI Bot Mode', 'A conversation, not a form');

  await r.click(page.locator('button[id$=":trigger"]').last(), { after: 700 });
  await r.click(page.getByRole('option', { name: s.level }), { after: 800 });
  if (key === 'bot') {
    r.cue('Let new people join from the link', 'Anyone with the link can register, then take part');
    await r.click(page.getByText('Allow Non-Participant registeration'), { after: 600 });
  } else {
    await page.getByText('This session will use this level’s discussion guide.').waitFor();
    r.cue('Choose the analysis to run', 'Themes, narratives, images, rankings and behaviour');
    await r.click(page.getByText('Select all', { exact: true }), { after: 900 });
  }
  await r.click(page.getByText('Start Immediately', { exact: true }), { after: 700 });

  const create = page.getByRole('button', { name: 'Create Session' }).last();
  if (existing) {
    await r.moveTo(create);
    await page.evaluate(() => window.__cursor && window.__cursor.pulse());
    await r.wait(400);
    r.pause();
    await page.goto(existing.url, { waitUntil: 'load' });
  } else {
    await r.click(create, { after: 300 });
    r.pause();
    await page.waitForURL((u) => !u.pathname.endsWith('/session/create'), { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    if (!UUID.test(page.url())) {
      // Not taken straight to the session: open it from the project's session list.
      await page.goto(state.read().projectUrl + '/session', { waitUntil: 'load' });
      await page.getByText(s.name, { exact: true }).first().click({ force: true });
      await page.waitForURL(UUID, { timeout: 30000 });
    }
  }
  await page.getByRole('button', { name: 'Copy Link' }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await r.resume();
  r.cue('Session live', 'Copy the link and share it with participants');
  await r.wait(1500);
  await r.click(page.getByRole('button', { name: 'Copy Link' }), { after: 600 });
  const link = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  if (!existing) {
    const sessions = { ...(state.read().sessions || {}), [key]: { id: page.url().match(UUID)[1], url: page.url(), link } };
    state.merge({ sessions });
    console.log(`${key} session:`, sessions[key]);
  }
  await r.wait(2200);
}

module.exports = async function record() {
  const { projectUrl } = state.read();
  if (!projectUrl) throw new Error('Run project-creation first.');
  const r = adminRecorder('soren-session-creation');
  const page = await r.open();
  await r.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ADMIN });
  await r.goto(projectUrl);
  await page.getByRole('button', { name: 'Create Session' }).waitFor();
  await r.wait(1500);

  await r.start();
  r.cue('Morning Beverage Habits Study', 'Two levels: a daily questionnaire and an AI conversation');
  await r.wait(2600);
  await createSession(r, page, 'bot', { first: true });

  r.pause();
  await page.goto(projectUrl, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Create Session' }).waitFor();
  await page.waitForTimeout(1500);
  await r.resume();
  await createSession(r, page, 'ai', { first: false });
  await r.stop();
};

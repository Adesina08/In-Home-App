// Shared setup for recording the hosted Soren platform (admin + respondent web app).
// Credentials come from SOREN_USER / SOREN_PASS and are never written to disk; only the
// resulting browser session is saved, under the git-ignored .work/soren/.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { CHROME, WORK } = require('../config');
const { Recorder } = require('../rec');

const ADMIN = 'https://admin.inicio-soren.xyz';
const USER_APP = 'https://user.inicio-soren.xyz';
const DIR = path.join(WORK, 'soren');
const AUTH = path.join(DIR, 'admin-auth.json');
const STATE = path.join(DIR, 'state.json');

/** Log in once and save the session; reused until it stops working. */
async function ensureLogin() {
  fs.mkdirSync(DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: fs.existsSync(AUTH) ? AUTH : undefined });
  const page = await ctx.newPage();
  await page.goto(ADMIN + '/dashboard', { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  if (await page.locator('input[name=password]').isVisible()) {
    const { SOREN_USER, SOREN_PASS } = process.env;
    if (!SOREN_USER || !SOREN_PASS) throw new Error('Not logged in: set SOREN_USER and SOREN_PASS.');
    await page.fill('input[name=username]', SOREN_USER);
    await page.fill('input[name=password]', SOREN_PASS);
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForURL('**/dashboard', { timeout: 30000 });
  }
  await ctx.storageState({ path: AUTH });
  await browser.close();
}

/** A desktop recorder already signed in to the admin console. */
function adminRecorder(name, opts = {}) {
  return new Recorder(name, { storageState: AUTH, waitUntil: 'load', ...opts });
}

/** IDs created by earlier flows (project, sessions, links), shared with later ones. */
const state = {
  read: () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {}),
  merge(patch) { const s = { ...state.read(), ...patch }; fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); return s; },
};

module.exports = { ADMIN, USER_APP, DIR, AUTH, ensureLogin, adminRecorder, state };

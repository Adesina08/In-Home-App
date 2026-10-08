const { chromium } = require('playwright');
const { CHROME, BASE, WORK } = require('../config');
const { staffLogin } = require('../rec');
(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await staffLogin(p);
  await p.goto(BASE + '/admin/studies/2/questionnaire/preview/1', { waitUntil: 'networkidle' });
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.getByText('Commit Checked Rows to Questionnaire').click()]);
  console.log('after commit', p.url());
  await p.screenshot({ path: WORK + '/shots/b1.png', fullPage: true });
  // open Q7 in editor
  await p.locator('text=How would you rate').first().click(); await p.waitForTimeout(1000);
  await p.screenshot({ path: WORK + '/shots/b2.png', fullPage: true });
  console.log(await p.$$eval('button:visible', (e) => e.map((x) => x.innerText.trim()).filter(Boolean).join(' | ')));
  await p.goto(BASE + '/admin/studies/2/questionnaire/live-preview', { waitUntil: 'networkidle' });
  await p.screenshot({ path: WORK + '/shots/b3.png', fullPage: true });
  console.log('live', p.url(), await p.evaluate(() => document.body.innerText.replace(/\n+/g, ' / ').slice(0, 600)));
  await b.close();
})();

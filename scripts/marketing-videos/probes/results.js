const { chromium } = require('playwright');
const { CHROME, BASE, WORK } = require('../config');
const { staffLogin } = require('../rec');
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  for (const [who, pages] of [['superadmin@inicio.demo', [['r-admin', '/admin?study=1'], ['r-ai', '/admin/ai-summary?study=1'], ['r-qc', '/admin/qc?study=1']]], ['client@inicio.demo', [['r-client', '/client?study=1'], ['r-client-ins', '/client/insights?study=1']]]]) {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await staffLogin(page, who);
    for (const [name, url] of pages) {
      await page.goto(BASE + url, { waitUntil: 'networkidle' }); await page.waitForTimeout(1500);
      await page.screenshot({ path: `${WORK}/shots/${name}.png`, fullPage: true });
      console.log(name, page.url(), await page.evaluate(() => document.body.scrollHeight));
    }
  }
  await browser.close();
})();

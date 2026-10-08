// Probe helper: open a URL on a phone viewport (optionally running steps), screenshot, list fields.
const { chromium } = require('playwright');
const { CHROME, BASE, WORK } = require('../config');
module.exports = async function probe(name, url, steps = async () => {}) {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  await page.goto(BASE + url, { waitUntil: 'networkidle' });
  try { await steps(page); } catch (e) { console.log('STEP ERROR', e.message.split('\n')[0]); }
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${WORK}/shots/${name}.png`, fullPage: true });
  console.log(name, '->', page.url());
  console.log(await page.$$eval('input,select,textarea,button,a', els => els.filter(e => e.offsetParent || e.type === 'radio' || e.type === 'checkbox').map(e => `${e.tagName}${e.type ? ':' + e.type : ''}${e.name ? '.' + e.name : ''}${e.id ? '#' + e.id : ''}[${(e.innerText || e.value || e.placeholder || '').replace(/\s+/g, ' ').slice(0, 30)}]`).join(' | ')));
  await browser.close();
};

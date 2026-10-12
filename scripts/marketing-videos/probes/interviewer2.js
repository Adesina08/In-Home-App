const { chromium } = require('playwright');
const { CHROME, BASE, WORK } = require('../config');
const { staffLogin } = require('../rec');
const vis = (p) => p.$$eval('input,select,textarea,button,a', (els) => els.filter((e) => e.offsetParent || ['radio', 'checkbox'].includes(e.type)).map((e) => `${e.tagName}:${e.type || ''}.${e.name || ''}=${e.value || ''}[${(e.innerText || e.placeholder || '').replace(/\s+/g, ' ').slice(0, 24)}]`).join(' | '));
(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const i = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 })).newPage(); await staffLogin(i, 'interviewer@inicio.demo');
  await i.goto(BASE + '/interviewer/register', { waitUntil: 'networkidle' });
  console.log('REGISTER', await vis(i));
  for (const [n, v] of [['age_band', 'Yes'], ['malt_drinker', 'Yes'], ['industry', 'No']]) await i.selectOption(`select[name="screener[${n}]"]`, v);
  await i.check('input[name=consent_given]'); await i.check('input[name=media_consent]');
  await i.fill('input[name=name]', 'Kemi Adewale'); await i.fill('input[name=contact]', '0805 777 8812');
  await Promise.all([i.waitForNavigation({ waitUntil: 'networkidle' }), i.getByText('Register & continue').click()]);
  console.log('AFTER REG', i.url()); await i.screenshot({ path: WORK + '/shots/iact.png', fullPage: true });
  console.log(await vis(i));
  await b.close();
})();

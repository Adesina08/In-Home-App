const { chromium } = require('playwright');
const { CHROME, BASE, WORK } = require('../config');
const { staffLogin } = require('../rec');
const vis = (p) => p.$$eval('input,select,textarea,button', (els) => els.filter((e) => e.offsetParent || ['radio', 'checkbox'].includes(e.type)).map((e) => `${e.tagName}:${e.type}.${e.name}[${(e.innerText || e.value || e.placeholder || '').replace(/\s+/g, ' ').slice(0, 28)}]`).join(' | '));
(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const sc = await b.newContext(); const sp = await sc.newPage(); await staffLogin(sp);
  const users = await (await sc.request.get(BASE + '/admin/users')).text();
  const iid = (users.match(/interviewer@inicio\.demo[\s\S]{0,4000}?\/admin\/users\/(\d+)/) || [])[1];
  console.log('interviewer id guess', iid);
  const r = await sc.request.post(BASE + '/admin/studies/1/research/assignment', { form: { user_id: iid || '2', enabled: '1', area: 'Surulere', household_target: '20' }, maxRedirects: 0 });
  console.log('assign', r.status(), r.headers().location);
  const ic = await b.newContext({ viewport: { width: 1440, height: 900 } }); const ip = await ic.newPage(); await staffLogin(ip, 'interviewer@inicio.demo');
  await ip.goto(BASE + '/interviewer/register', { waitUntil: 'networkidle' });
  await ip.screenshot({ path: WORK + '/shots/ireg2.png', fullPage: true });
  console.log(await ip.evaluate(() => document.querySelector('main, body').innerText.replace(/\n+/g, ' / ').slice(0, 1500)));
  console.log(await vis(ip));
  await b.close();
})();

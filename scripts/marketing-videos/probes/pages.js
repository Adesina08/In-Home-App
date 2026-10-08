// Screenshot + list controls for staff pages: node probes/pages.js <email> <name>=<url> ...
const { chromium } = require('playwright');
const { CHROME, BASE, WORK } = require('../config');
const { staffLogin } = require('../rec');
(async () => {
  const [email, ...pages] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: CHROME });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await staffLogin(p, email);
  console.log('landed', p.url());
  for (const spec of pages) {
    const [name, url] = spec.split('=');
    await p.goto(BASE + url, { waitUntil: 'networkidle' }).catch((e) => console.log('ERR', e.message));
    await p.screenshot({ path: `${WORK}/shots/${name}.png`, fullPage: true });
    const info = await p.evaluate(() => ({ h: [...document.querySelectorAll('h1,h2,h3,summary')].map((x) => x.innerText.trim()).filter(Boolean).slice(0, 25).join(' | '),
      forms: [...document.forms].map((f) => `${f.getAttribute('action')}[${[...f.elements].filter((e) => e.name).map((e) => e.name).join(',')}]`).slice(0, 15).join('\n   ') }));
    console.log(`\n== ${name} ${p.url()}\n H: ${info.h}\n F: ${info.forms}`);
  }
  await b.close();
})();

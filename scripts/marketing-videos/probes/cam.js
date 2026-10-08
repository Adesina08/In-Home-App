const { chromium } = require('playwright');
const { CHROME, BASE, WORK } = require('../config');
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${WORK}/camera.mjpeg`] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  await page.goto(BASE + '/r/' + process.argv[2] + '/diary/new?mode=standard', { waitUntil: 'networkidle' });
  await page.getByText('Tap to open camera').first().click(); await page.waitForTimeout(2000); await page.click('#camShutterBtn'); await page.waitForTimeout(1500);
  await page.screenshot({ path: WORK + '/shots/cam1.png' });
  console.log(await page.$$eval('button:visible,input:visible', els => els.map(e => `${e.tagName}#${e.id}.${e.className.toString().slice(0,30)}[${(e.innerText||e.value||'').replace(/\s+/g,' ').slice(0,30)}]`).join(' | ')));
  await browser.close();
})();

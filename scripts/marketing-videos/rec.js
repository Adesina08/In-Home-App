// Screen recorder for marketing videos.
// Captures crisp JPEG frames over the Chrome DevTools screencast (Playwright's
// built-in recordVideo is low bitrate), draws a visible animated cursor, and
// logs caption cues against the recording clock.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { FFMPEG, CHROME, BASE, WORK } = require('./config');

const CURSOR_JS = `(() => {
  if (window.__cursor) return;
  const install = () => {
    if (document.getElementById('__mkt_cursor')) return;
    const c = document.createElement('div');
    c.id = '__mkt_cursor';
    c.innerHTML = window.__mktTouch
      ? '<i style="position:absolute;left:-17px;top:-17px;width:34px;height:34px;border-radius:50%;background:rgba(17,24,39,.28);border:2px solid rgba(255,255,255,.9);box-shadow:0 2px 6px rgba(0,0,0,.25)"></i><span></span>'
      : '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="#111827" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span></span>';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(var(--x,-100px),var(--y,-100px));transition:transform var(--d,0ms) cubic-bezier(.45,.05,.25,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.3))';
    const ring = c.querySelector('span');
    ring.style.cssText = 'position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;background:rgba(37,99,235,.35);transform:scale(0);opacity:0';
    document.documentElement.appendChild(c);
    const s = sessionStorage.getItem('__mkt_cursor_pos');
    if (s) { const [x, y] = JSON.parse(s); c.style.setProperty('--x', x + 'px'); c.style.setProperty('--y', y + 'px'); }
  };
  window.__cursor = {
    move(x, y, d) { install(); const c = document.getElementById('__mkt_cursor'); c.style.setProperty('--d', d + 'ms'); c.style.setProperty('--x', x + 'px'); c.style.setProperty('--y', y + 'px'); sessionStorage.setItem('__mkt_cursor_pos', JSON.stringify([x, y])); },
    pulse() { const r = document.querySelector('#__mkt_cursor span'); if (!r) return; r.style.transition = 'none'; r.style.transform = 'scale(.2)'; r.style.opacity = '1'; r.offsetWidth; r.style.transition = 'transform .4s, opacity .4s'; r.style.transform = 'scale(1.6)'; r.style.opacity = '0'; },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();`;

class Recorder {
  constructor(name, { width = 1440, height = 900, mobile = false, scale = 1, camera = null, mic = null } = {}) {
    Object.assign(this, { name, width, height, mobile, scale, camera, mic });
    this.dir = path.join(WORK, 'raw', name);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.dir, 'frames'), { recursive: true });
    this.frames = []; this.cues = []; this.recording = false; this.t0 = null; this.paused = 0; this.pausedAt = null;
  }

  async open() {
    // camera: an .mjpeg file Chrome plays as the device camera (fictional pack shots).
    // mic: a .wav Chrome plays as the device microphone.
    const args = this.camera ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${this.camera}`] : [];
    if (this.mic) args.push(`--use-file-for-fake-audio-capture=${this.mic}`);
    this.browser = await chromium.launch({ executablePath: CHROME, args });
    this.context = await this.browser.newContext({
      permissions: this.camera ? ['camera', 'microphone'] : [],
      viewport: { width: this.width, height: this.height }, deviceScaleFactor: this.scale,
      isMobile: this.mobile, hasTouch: this.mobile, locale: 'en-GB', timezoneId: 'Africa/Lagos', colorScheme: 'light',
      userAgent: this.mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : undefined,
    });
    if (this.mobile) await this.context.addInitScript(() => { window.__mktTouch = true; });
    // Respondent pages default to dark unless a preference is saved; record in light for a consistent look.
    await this.context.addInitScript(() => { try { localStorage.setItem('inicio-theme', 'light'); } catch (e) {} });
    await this.context.addInitScript(CURSOR_JS);
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(15000);
    return this.page;
  }

  async start() {
    this.cdp = await this.context.newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
      if (this.recording) {
        if (this.t0 === null) this.t0 = metadata.timestamp;
        const file = path.join(this.dir, 'frames', `${String(this.frames.length).padStart(6, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        this.frames.push({ file, t: metadata.timestamp - this.t0 - this.paused });
      }
      this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    this.recording = true;
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: Math.round(this.width * this.scale), maxHeight: Math.round(this.height * this.scale), everyNthFrame: 1 });
    this.wallStart = Date.now();
    await this.wait(400);
  }

  now() { return (Date.now() - this.wallStart) / 1000 - this.paused; }
  /** Stop capturing (e.g. through a page reload); the gap is cut from the video. */
  pause() { if (this.recording) { this.recording = false; this.pausedAt = Date.now(); } }
  async resume() {
    if (this.pausedAt === null) return;
    this.paused += (Date.now() - this.pausedAt) / 1000;
    this.pausedAt = null; this.recording = true;
    // Chrome only sends a frame when something repaints; force one so the
    // reloaded page appears straight away instead of the last pre-save frame.
    await this.page.evaluate(() => new Promise((done) => {
      const dot = document.createElement('div');
      dot.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;background:rgba(0,0,0,0.01);z-index:2147483647';
      document.documentElement.appendChild(dot);
      requestAnimationFrame(() => requestAnimationFrame(() => { dot.remove(); done(); }));
    }));
  }
  cue(text, sub = '') { this.cues.push({ t: this.now(), text, sub }); }
  /** A named moment in the recording, e.g. where to lay in a voice-over. */
  mark(name) { (this.marks = this.marks || {})[name] = this.now(); }
  wait(ms) { return this.page.waitForTimeout(ms); }

  async goto(url) { await this.page.goto(url.startsWith('http') ? url : BASE + url, { waitUntil: 'networkidle' }); await this.wait(500); }

  async moveTo(locator, ms = 700) {
    const el = typeof locator === 'string' ? this.page.locator(locator).first() : locator;
    await el.waitFor({ state: 'visible' });
    let box = await el.boundingBox();
    // Glide to anything off screen rather than jumping, like a person scrolling.
    if (box.y < 70 || box.y + box.height > this.height - 70) {
      await this.scrollBy(Math.round(box.y + box.height / 2 - this.height * 0.55), 800);
      box = await el.boundingBox();
    }
    await this.wait(150);
    const x = box.x + Math.min(box.width / 2, 60), y = box.y + box.height / 2;
    await this.page.evaluate(([x, y, ms]) => window.__cursor && window.__cursor.move(x, y, ms), [x, y, ms]);
    await this.wait(ms + 120);
    return el;
  }

  /** Click a submit that reloads the page; the reload itself is not captured. Call resume() once ready. */
  async save(locator) {
    const el = await this.moveTo(locator);
    await this.page.evaluate(() => window.__cursor && window.__cursor.pulse());
    await this.wait(350);
    this.pause();
    await Promise.all([this.page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}), el.click()]);
  }

  async click(locator, { nav = false, after = 600 } = {}) {
    const el = await this.moveTo(locator);
    await this.page.evaluate(() => window.__cursor && window.__cursor.pulse());
    await this.wait(180);
    if (nav) await Promise.all([this.page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}), el.click()]);
    else await el.click();
    await this.wait(after);
  }

  async type(locator, text, { delay = 55, clear = true } = {}) {
    const el = await this.moveTo(locator);
    await this.page.evaluate(() => window.__cursor && window.__cursor.pulse());
    await el.click();
    if (clear) await el.fill('');
    await el.pressSequentially(text, { delay });
    await this.wait(350);
  }

  async select(locator, value) { const el = await this.moveTo(locator); await el.selectOption(value); await this.wait(500); }

  async scrollBy(dy, ms = 900) {
    await this.page.evaluate(([dy, ms]) => new Promise((r) => {
      const y0 = window.scrollY, t0 = performance.now();
      const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; window.scrollTo(0, y0 + dy * e); k < 1 ? requestAnimationFrame(step) : r(); };
      requestAnimationFrame(step);
    }), [dy, ms]);
    await this.wait(300);
  }

  /** Glide so the element's top sits near the top of the screen. */
  async scrollTo(locator, { offset = 110, ms = 1400 } = {}) {
    const el = typeof locator === 'string' ? this.page.locator(locator).first() : locator;
    await el.waitFor({ state: 'attached' });
    const top = await el.evaluate((e) => e.getBoundingClientRect().top);
    await this.scrollBy(Math.round(top - offset), ms);
  }

  async stop() {
    await this.wait(600);
    this.recording = false;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    const duration = this.now();
    await this.browser.close();
    // Variable-rate frames -> constant 30fps. Each frame lasts until the next one arrives.
    const list = this.frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (this.frames[i + 1]?.t ?? duration) - f.t).toFixed(3)}`).join('\n') + `\nfile '${this.frames.at(-1).file}'\n`;
    fs.writeFileSync(path.join(this.dir, 'frames.txt'), list);
    const out = path.join(this.dir, 'screen.mp4');
    const w = Math.round(this.width * this.scale / 2) * 2, h = Math.round(this.height * this.scale / 2) * 2;
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(this.dir, 'frames.txt'),
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=white,fps=30,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', out]);
    fs.writeFileSync(path.join(this.dir, 'cues.json'), JSON.stringify({ duration, cues: this.cues, marks: this.marks || {}, width: w, height: h, mobile: this.mobile }, null, 2));
    fs.rmSync(path.join(this.dir, 'frames'), { recursive: true, force: true });
    console.log(`${this.name}: ${this.frames.length} frames, ${duration.toFixed(1)}s -> ${out}`);
    return out;
  }
}

/** Log in on the staff console before recording starts. */
async function staffLogin(page, email = 'superadmin@inicio.demo') {
  await page.goto(BASE + '/login');
  await page.getByText('Proceed to login').click();
  await page.fill('#email', email);
  await page.fill('input[name=password]', 'Demo1234!');
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
}

/** Most recent verification code "delivered" to the demo inbox (see demo-messaging.js). */
function latestCode() {
  const lines = fs.readFileSync(path.join(WORK, 'inbox.jsonl'), 'utf8').trim().split('\n').reverse();
  for (const line of lines) { const m = JSON.parse(line); if (m.variables && m.variables.code) return String(m.variables.code); }
  throw new Error('No verification code in the demo inbox.');
}

module.exports = { Recorder, staffLogin, latestCode, BASE };

// A long-running recorder driven step by step, for flows that can only be walked once
// (e.g. a respondent verified by a WhatsApp code someone reads out). Each step is a JS
// file dropped into .work/soren/live/<name>/cmd/ as `NNN.js` exporting async (r, page, ctx);
// its result (plus a screenshot) is written to out/NNN.txt. A step exporting `stop` finishes.
// Steps get ctx.helpers (soren/live-helpers.js): recorded() and rollback() cut failed attempts.
//   node soren/live.js <name> [--phone] [--admin] [--resume-login] [--camera=<mjpeg>] [--mic=<wav>]
const fs = require('fs');
const path = require('path');
const { Recorder } = require('../rec');
const { DIR, AUTH } = require('./common');

const [name, ...flags] = process.argv.slice(2);
const base = path.join(DIR, 'live', name), cmdDir = path.join(base, 'cmd'), outDir = path.join(base, 'out');
fs.mkdirSync(cmdDir, { recursive: true }); fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const describe = (page) => page.evaluate(() => ({
  url: location.href,
  text: document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 2500),
  inputs: [...document.querySelectorAll('input,textarea,select')].filter((e) => e.type !== 'hidden')
    .map((e) => `${e.tagName.toLowerCase()}[type=${e.type || ''} name=${e.name || ''} ph="${e.placeholder || ''}"]${e.checked ? ' checked' : ''}`).slice(0, 40),
  buttons: [...new Set([...document.querySelectorAll('button,[role=button],a')].map((x) => x.innerText.trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 40),
}));

(async () => {
  const phone = flags.includes('--phone');
  const r = new Recorder(`soren-${name}`, {
    waitUntil: 'load',
    ...(phone ? { width: 390, height: 844, mobile: true, scale: 2 } : {}),
    ...(flags.includes('--admin') ? { storageState: AUTH } : {}),
    ...(flags.includes('--resume-login') && fs.existsSync(path.join(base, 'storage.json')) ? { storageState: path.join(base, 'storage.json') } : {}),
    // Chrome plays these as the device camera and microphone (from the start each time one opens).
    camera: (flags.find((f) => f.startsWith('--camera=')) || '').slice(9) || null,
    mic: (flags.find((f) => f.startsWith('--mic=')) || '').slice(6) || null,
  });
  const page = await r.open();
  const ctx = { helpers: require('./live-helpers'), describe: () => describe(page), shot: async (f) => { const p = path.join(outDir, f); await page.screenshot({ path: p }); return p; } };
  console.log(`live ${name}: ready, waiting for steps in ${cmdDir}`);
  const done = new Set();
  for (;;) {
    const next = fs.readdirSync(cmdDir).filter((f) => f.endsWith('.js') && !done.has(f)).sort()[0];
    if (!next) { await sleep(500); continue; }
    done.add(next);
    const id = next.replace(/\.js$/, '');
    let result, mod = null;
    try { mod = require(path.join(cmdDir, next)); result = await mod(r, page, ctx); } catch (e) { result = { error: e.message.split('\n').slice(0, 6).join('\n') }; }
    // Survive a crash: keep the signed-in session and the timing of every captured frame.
    await r.context.storageState({ path: path.join(base, 'storage.json') }).catch(() => {});
    fs.writeFileSync(path.join(base, 'timeline.json'), JSON.stringify({ frames: r.frames, cues: r.cues, marks: r.marks || {}, paused: r.paused }));
    const state = await describe(page).catch((e) => ({ error: e.message }));
    const shot = await ctx.shot(`${id}.png`).catch(() => null);
    fs.writeFileSync(path.join(outDir, `${id}.txt`), JSON.stringify({ result, state, shot }, null, 2));
    if (mod && mod.stop) { if (r.recording !== undefined && r.cdp) await r.stop(); console.log('stopped'); break; }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

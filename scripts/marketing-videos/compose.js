// Turns a raw screen recording + caption cues into a finished 1920x1080 video:
// intro card -> framed recording with captions -> outro card, optional music bed.
// Cards and captions are HTML rendered to PNG in Chromium, so they use the
// app's own fonts and colours; ffmpeg does the assembly.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { FFMPEG, CHROME, APP, WORK } = require('./config');

const LOGO = 'data:image/png;base64,' + fs.readFileSync(path.join(APP, 'public/icons/logo-header.png')).toString('base64');
const W = 1920, H = 1080, FPS = 30, INTRO = 3.5, OUTRO = 4, XF = 0.6;

const FONTS = '<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">';
const BASE_CSS = `*{margin:0;box-sizing:border-box} body{width:${W}px;height:${H}px;font-family:Inter,sans-serif;overflow:hidden}
  .bg{position:absolute;inset:0;background:radial-gradient(1200px 700px at 15% 10%,#eaf4fc,transparent),radial-gradient(900px 700px at 90% 90%,#cfe3f5,transparent),#dcebf7}
  .brand{display:flex;align-items:center;gap:16px;color:#1b2f5b;font-family:'Bricolage Grotesque';font-weight:800;letter-spacing:-.5px}`;
const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function card({ kicker, title, sub, outro }) {
  return `<html><head>${FONTS}<style>${BASE_CSS}
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 180px}
    .kicker{font-family:'IBM Plex Mono',monospace;font-size:24px;letter-spacing:6px;color:#3b6aa8;text-transform:uppercase;margin-top:56px}
    h1{font-family:'Bricolage Grotesque';font-weight:800;font-size:112px;line-height:1;letter-spacing:-3px;color:#1b2f5b;margin-top:22px;max-width:1400px}
    p{font-size:36px;color:#3d5579;margin-top:30px;max-width:1300px;line-height:1.35}
    .steps{display:flex;gap:18px;margin-top:56px}.steps div{padding:18px 28px;border-radius:18px;background:rgba(255,255,255,.7);border:1px solid #c9dcef;font-weight:600;color:#1b2f5b;font-size:24px}
    .ring{position:absolute;right:-220px;bottom:-260px;width:760px;height:760px;border-radius:50%;border:2px solid #b9d3ec}</style></head>
    <body><div class="bg"></div><div class="ring"></div><div class="wrap">
      <div class="brand" style="font-size:52px"><img src="${LOGO}" style="height:64px">INICIO Diary</div>
      ${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ''}
      <h1 style="${kicker ? '' : 'margin-top:56px'}">${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}
      ${outro ? '<div class="steps"><div>01 Study</div><div>02 Diary</div><div>03 Review</div><div>04 Report</div></div>' : ''}
    </div></body></html>`;
}

function background(L) {
  return `<html><head>${FONTS}<style>${BASE_CSS}</style></head><body><div class="bg"></div>
    ${L.kind === 'desktop'
      ? `<div style="position:absolute;left:${L.x}px;top:${L.y}px;width:${L.w}px;height:${L.h}px;border-radius:22px;box-shadow:0 40px 90px rgba(27,47,91,.28),0 0 0 1px rgba(27,47,91,.08);background:#fff"></div>`
      : `<div style="position:absolute;left:${L.px}px;top:${L.py}px;width:${L.pw}px;height:${L.ph}px;border-radius:72px;background:#0f172a;box-shadow:0 50px 100px rgba(27,47,91,.35)"></div>
         <div class="brand" style="position:absolute;left:${L.cx}px;top:90px;font-size:34px"><img src="${LOGO}" style="height:44px">INICIO Diary</div>`}
  </body></html>`;
}

const mask = (w, h, r) => `<html><body style="margin:0;background:transparent"><div style="width:${w}px;height:${h}px;border-radius:${r}px;background:#fff"></div></body></html>`;

function caption(cue, L) {
  if (L.kind === 'desktop') {
    return `<html><head>${FONTS}<style>*{margin:0} body{background:transparent;font-family:Inter} #c{display:inline-block;padding:22px 40px;border-radius:24px;background:rgba(15,31,61,.92);color:#fff;box-shadow:0 20px 50px rgba(0,0,0,.25);text-align:center}
      b{display:block;font-family:'Bricolage Grotesque';font-weight:800;font-size:44px;letter-spacing:-.5px} span{display:block;font-size:26px;color:#bcd3ee;margin-top:6px}</style></head>
      <body><div id="c"><b>${esc(cue.text)}</b>${cue.sub ? `<span>${esc(cue.sub)}</span>` : ''}</div></body></html>`;
  }
  return `<html><head>${FONTS}<style>*{margin:0} body{background:transparent;font-family:Inter;width:${L.cw}px} #c{padding:8px 0}
    b{display:block;font-family:'Bricolage Grotesque';font-weight:800;font-size:76px;line-height:1.02;letter-spacing:-2px;color:#1b2f5b} span{display:block;font-size:36px;line-height:1.35;color:#3d5579;margin-top:24px}
    i{display:block;width:90px;height:8px;border-radius:4px;background:#3b6aa8;margin-bottom:34px}</style></head>
    <body><div id="c"><i></i><b>${esc(cue.text)}</b>${cue.sub ? `<span>${esc(cue.sub)}</span>` : ''}</div></body></html>`;
}

function layoutFor(meta) {
  if (!meta.mobile) {
    const w = 1600, h = Math.round(w * meta.height / meta.width / 2) * 2;
    return { kind: 'desktop', w, h, x: (W - w) / 2, y: 24, sw: w, sh: h, sx: (W - w) / 2, sy: 24 };
  }
  const sh = 900, sw = Math.round(sh * meta.width / meta.height / 2) * 2, bez = 16;
  const pw = sw + bez * 2, ph = sh + bez * 2, px = 250, py = (H - ph) / 2;
  return { kind: 'phone', sw, sh, sx: px + bez, sy: py + bez, pw, ph, px, py, cx: 900, cw: 860 };
}

async function renderGraphics(dir, meta, L, opts) {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const shot = async (html, file, { el, transparent } = {}) => {
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await (el ? page.locator(el) : page).screenshot({ path: path.join(dir, file), omitBackground: !!transparent });
  };
  await shot(card({ kicker: opts.kicker, title: opts.title, sub: opts.subtitle }), 'intro.png');
  await shot(card({ title: opts.outroTitle || 'Every study, in motion.', sub: opts.outroSub || 'Research. Insights. Impact.', outro: true }), 'outro.png');
  await shot(background(L), 'bg.png');
  await page.setViewportSize({ width: L.sw, height: L.sh });
  await shot(mask(L.sw, L.sh, L.kind === 'desktop' ? 22 : 56), 'mask.png', { transparent: true });
  await page.setViewportSize({ width: W, height: H });
  for (const [i, cue] of meta.cues.entries()) await shot(caption(cue, L), `cap-${i}.png`, { el: '#c', transparent: true });
  await browser.close();
}

function ffmpeg(args) {
  // Few threads and a single filter thread keep peak memory low on a laptop.
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '4', '-filter_threads', '1', ...args.map(String)], { maxBuffer: 64 * 1024 * 1024 });
}

const VIDEO_OUT = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS)];

/** Pass 1 for one recording: framed on the background, captions faded in and out. */
async function renderPart(rawName, opts) {
  const raw = path.join(WORK, 'raw', rawName);
  const meta = JSON.parse(fs.readFileSync(path.join(raw, 'cues.json'), 'utf8'));
  const dir = path.join(raw, 'gfx'); fs.mkdirSync(dir, { recursive: true });
  const L = layoutFor(meta);
  await renderGraphics(dir, meta, L, opts);
  const D = meta.duration;
  // Each caption image is only decoded for the seconds it is on screen, shifted to its start time.
  const args = ['-loop', '1', '-framerate', FPS, '-t', D, '-i', path.join(dir, 'bg.png'), '-i', path.join(raw, 'screen.mp4'), '-loop', '1', '-framerate', FPS, '-t', D, '-i', path.join(dir, 'mask.png')];
  const f = [
    `[1:v]scale=${L.sw}:${L.sh}:flags=lanczos,fps=${FPS},format=rgba[scr]`,
    '[2:v]format=rgba,alphaextract[m]', '[scr][m]alphamerge[scrm]',
    `[0:v][scrm]overlay=${L.sx}:${L.sy}:shortest=1[v0]`,
  ];
  let last = 'v0', input = 3;
  meta.cues.forEach((c, i) => {
    const a = Math.max(0, c.t + 0.15), b = Math.min(D - 0.2, (meta.cues[i + 1]?.t ?? D) - 0.25), d = b - a;
    if (d < 0.8) return;
    args.push('-loop', '1', '-framerate', FPS, '-t', d.toFixed(2), '-i', path.join(dir, `cap-${i}.png`));
    const pos = L.kind === 'desktop' ? `x=(W-w)/2:y=${L.y + L.h - 60}-h` : `x=${L.cx}:y=(H-h)/2+40`;
    f.push(`[${input}:v]format=rgba,fade=t=in:st=0:d=0.35:alpha=1,fade=t=out:st=${(d - 0.35).toFixed(2)}:d=0.35:alpha=1,setpts=PTS-STARTPTS+${a.toFixed(2)}/TB[c${i}]`);
    f.push(`[${last}][c${i}]overlay=${pos}:eof_action=pass[v${i + 1}]`);
    last = `v${i + 1}`; input++;
  });
  f.push(`[${last}]format=yuv420p[vout]`);
  const file = path.join(raw, 'main.mp4');
  ffmpeg([...args, '-filter_complex', f.join(';'), '-map', '[vout]', ...VIDEO_OUT, '-t', D.toFixed(2), file]);
  return { file, D, meta, dir };
}

/**
 * name: output file. opts.parts: recordings to join in order (default [name]).
 * opts.voiceovers: [{ part, mark, file, delay }] -- audio laid in at a recorder
 * mark (r.mark) plus delay seconds; music ducks under it.
 */
async function compose(name, opts) {
  const parts = [];
  for (const rawName of opts.parts || [name]) parts.push(await renderPart(rawName, opts));
  const dir = parts[0].dir;
  const card = (png, t, out) => ffmpeg(['-loop', '1', '-framerate', FPS, '-t', t, '-i', path.join(dir, png), '-vf', 'format=yuv420p', ...VIDEO_OUT, out]);
  const intro = path.join(dir, 'intro.mp4'), outro = path.join(dir, 'outro.mp4');
  card('intro.png', INTRO, intro);
  card('outro.png', OUTRO, outro);

  // Cross-fade intro -> parts -> outro. Each fade overlaps the previous clip by XF.
  const clips = [{ file: intro, D: INTRO }, ...parts, { file: outro, D: OUTRO }];
  const starts = []; let t = 0;
  clips.forEach((c, i) => { starts.push(t); t += c.D - (i < clips.length - 1 ? XF : 0); });
  const total = t;
  const join = clips.flatMap((c) => ['-i', c.file]);
  const jf = []; let prev = '0:v';
  for (let i = 1; i < clips.length; i++) {
    const out = i === clips.length - 1 ? 'vout' : `x${i}`;
    jf.push(`[${prev}][${i}:v]xfade=transition=fade:duration=${XF}:offset=${starts[i].toFixed(3)}[${out}]`);
    prev = out;
  }
  let input = clips.length;
  const voices = (opts.voiceovers || []).map((v) => {
    const partIndex = (opts.parts || [name]).indexOf(v.part);
    const mark = clips[partIndex + 1].meta.marks?.[v.mark];
    if (mark === undefined) throw new Error(`No mark "${v.mark}" in ${v.part}`);
    // Normalise speech in its own pass: chaining loudnorm into adelay loses the delay.
    const level = path.join(WORK, 'raw', `${name}-vo-${v.mark}.wav`);
    ffmpeg(['-i', v.file, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', level]);
    join.push('-i', level);
    return { input: input++, at: starts[partIndex + 1] + mark + (v.delay || 0) };
  });
  const voiceMix = voices.map((v, i) => `[${v.input}:a]adelay=delays=${Math.round(v.at * 1000)}:all=1,apad[vo${i}]`);
  if (opts.music) {
    join.push('-stream_loop', '-1', '-i', opts.music);
    jf.push(`[${input}:a]aresample=48000,atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,volume=${opts.musicVolume ?? 0.8},afade=t=in:d=1.5,afade=t=out:st=${(total - 2.5).toFixed(2)}:d=2.5[mus]`);
  } else jf.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total.toFixed(2)}[mus]`);
  if (voices.length) {
    jf.push(...voiceMix, `${voices.map((v, i) => `[vo${i}]`).join('')}amix=inputs=${voices.length}:normalize=0,atrim=0:${total.toFixed(2)},asplit[vox][key]`,
      // Duck the music while someone is speaking.
      '[mus][key]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400[duck]', '[duck][vox]amix=inputs=2:normalize=0[aout]');
  } else jf.push('[mus]anull[aout]');

  const out = path.join(WORK, 'out', `${opts.file || name}.mp4`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  ffmpeg([...join, '-filter_complex', jf.join(';'), '-map', '[vout]', '-map', '[aout]', ...VIDEO_OUT, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', total.toFixed(2), out]);
  console.log(`${name}: ${total.toFixed(1)}s -> ${out}`);
  return out;
}

module.exports = { compose };

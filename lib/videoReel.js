// Builds a highlight reel for a video summary: an intro card, then for each
// key point a title card followed by short clips from the respondent videos
// picked for it, an optional outro card, and optional background music --
// joined into one MP4.
//
// Look and length come from reel settings (lib/reelSettings.js): format
// (16:9, 9:16 or 1:1), brand colours, logo, intro/outro text, captions and
// subtitles, music, and length limits.
//
// Same bundled `ffmpeg-static` binary as ffmpegFrames.js/ffmpegAudio.js. That
// build has no drawtext filter, so text (title cards, captions) is rendered
// through libass from a generated .ass file, with a bundled font so it looks
// the same on a server with no system fonts.
//
// Every segment is encoded to the same size, frame rate and audio format, so
// the join is a stream copy; music is mixed in one final audio-only pass.

const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { materializeLocalFile } = require("./mediaStorage");
const reelSettings = require("./reelSettings");

const FONTS_DIR = path.join(__dirname, "assets", "fonts");
const TITLE_SECONDS = 3;
const CAPTION_SIZE = { small: 22, medium: 28, large: 36 };

function run(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ["-hide_banner", "-y", ...args], { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg failed: ${String(stderr || err.message).trim().split("\n").slice(-3).join(" ")}`));
      resolve(stderr);
    });
  });
}

/** ffmpeg's description of a file's streams (it exits non-zero with no output named, which is expected). */
function probe(file) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ["-hide_banner", "-i", file], { timeout: 20000 }, (err, stdout, stderr) => resolve(String(stderr)));
  });
}

/** True when the file has an audio stream (a silent video still needs one for the join). */
async function hasAudio(file) {
  return /Stream #.*Audio:/.test(await probe(file));
}

async function durationSeconds(file) {
  const m = (await probe(file)).match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

// ffmpeg filter arguments treat : , ' \ [ ] specially; the paths we pass are
// our own temp paths, but the install directory may contain spaces etc.
function filterPath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function assTime(seconds) {
  const centis = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(centis / 360000)}:${String(Math.floor(centis / 6000) % 60).padStart(2, '0')}:${String(Math.floor(centis / 100) % 60).padStart(2, '0')}.${String(centis % 100).padStart(2, '0')}`;
}
function assText(text) {
  return String(text || "").replace(/[{}\\]/g, "").replace(/\r?\n/g, "\\N");
}
/** #RRGGBB -> libass &HAABBGGRR (alpha 00 = opaque). */
function assColor(hex, alpha = "00") {
  const h = String(hex || "#FFFFFF").replace("#", "");
  return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/** One .ass subtitle file: a title card's centred text, or a clip's caption and speech subtitles. */
function writeAss(file, { title, subtitle, caption, seconds, subtitles = [] }, settings) {
  const { width, height } = reelSettings.FORMATS[settings.format];
  const narrow = width < 1000;
  const side = narrow ? 50 : 120;
  const captionSize = CAPTION_SIZE[settings.captions.size];
  const captionTop = settings.captions.position === "top";
  const titleLength = String(title || "").length;
  const titleSize = (titleLength > 240 ? 34 : titleLength > 120 ? 44 : 54) - (narrow ? 6 : 0);
  const { text: textColor, accent } = settings.brand;
  const end = assTime(seconds);
  const lines = [];
  if (title) lines.push(`Dialogue: 0,0:00:00.00,${end},Title,,0,0,0,,${assText(title)}`);
  if (subtitle) lines.push(`Dialogue: 0,0:00:00.00,${end},Subtitle,,0,0,0,,${assText(subtitle)}`);
  if (caption) lines.push(`Dialogue: 0,0:00:00.00,${end},Caption,,0,0,0,,${assText(caption)}`);
  for (const sub of subtitles) {
    if (sub.end > sub.start) lines.push(`Dialogue: 0,${assTime(sub.start)},${assTime(sub.end)},Speech,,0,0,0,,${assText(sub.text)}`);
  }
  fs.writeFileSync(file, [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "WrapStyle: 0", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Title,Liberation Sans,${titleSize},${assColor(textColor)},${assColor(textColor)},&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,${side},${side},40,1`,
    `Style: Subtitle,Liberation Sans,30,${assColor(accent)},${assColor(textColor)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,${side},${side},${Math.round(height * 0.2)},1`,
    `Style: Caption,Liberation Sans,${captionSize},&H00FFFFFF,&H00FFFFFF,&H00000000,${assColor(settings.brand.background, "33")},0,0,0,0,100,100,0,0,3,10,0,${captionTop ? 7 : 1},40,40,40,1`,
    `Style: Speech,Liberation Sans,${Math.round(captionSize * 1.08)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,0,0,0,0,100,100,0,0,3,8,0,2,${narrow ? 40 : 60},${narrow ? 40 : 60},${captionTop ? 60 : Math.round(height * 0.14)},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...lines, "",
  ].join("\n"));
}

const OUTPUT_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-shortest"];

/** How long a title card stays up: the configured minimum, longer for long text. */
function titleSecondsFor(title, settings) {
  const minimum = settings ? settings.length.title_seconds : TITLE_SECONDS;
  return Math.min(20, Math.max(minimum, Math.ceil(String(title || "").split(/\s+/).length / 3) + 1));
}

async function titleSegment(dir, index, { title, subtitle }, { settings, logoFile }) {
  const { width, height } = reelSettings.FORMATS[settings.format];
  const seconds = titleSecondsFor(title, settings);
  const ass = path.join(dir, `title-${index}.ass`);
  const out = path.join(dir, `seg-${String(index).padStart(3, "0")}.mp4`);
  writeAss(ass, { title, subtitle, seconds }, settings);
  const background = `color=c=0x${settings.brand.background.slice(1)}:s=${width}x${height}:d=${seconds}:r=30`;
  const text = `ass='${filterPath(ass)}':fontsdir='${filterPath(FONTS_DIR)}',setsar=1`;
  const inputs = ["-f", "lavfi", "-i", background, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"];
  // The logo sits centred above the title text.
  const filter = logoFile
    ? ["-i", logoFile, "-filter_complex", `[2:v]scale=-1:${Math.round(height * 0.12)}[logo];[0:v][logo]overlay=(W-w)/2:${Math.round(height * 0.08)},${text}[v]`, "-map", "[v]", "-map", "1:a"]
    : ["-vf", text];
  await run([...inputs, ...filter, "-t", String(seconds), ...OUTPUT_ARGS, out]);
  return out;
}

async function clipSegment(dir, index, source, step, { settings, logoFile }) {
  const { width, height } = reelSettings.FORMATS[settings.format];
  const ass = path.join(dir, `clip-${index}.ass`);
  const out = path.join(dir, `seg-${String(index).padStart(3, "0")}.mp4`);
  const seconds = step.end - step.start;
  const actualDuration = await durationSeconds(source);
  if (!actualDuration || step.end > actualDuration + 0.15) throw new Error('Selected clip exceeds source duration.');
  writeAss(ass, { caption: step.caption, seconds, subtitles: step.subtitles }, settings);
  const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,ass='${filterPath(ass)}':fontsdir='${filterPath(FONTS_DIR)}'`;
  const withAudio = await hasAudio(source);
  const inputs = ['-ss', String(step.start), '-i', source, ...(withAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'])];
  const audio = withAudio ? '0:a:0' : '1:a:0';
  const watermark = logoFile && settings.brand.logo_on_clips;
  const video = watermark
    // A small, slightly transparent logo in the top-right corner.
    ? ['-i', logoFile, '-filter_complex', `[0:v]${fit}[base];[${withAudio ? 1 : 2}:v]scale=-1:${Math.round(height * 0.07)},format=rgba,colorchannelmixer=aa=0.85[logo];[base][logo]overlay=W-w-24:24[v]`, '-map', '[v]', '-map', audio]
    : ['-map', '0:v:0', '-map', audio, '-vf', fit];
  await run([...inputs, ...video, '-t', String(seconds), ...OUTPUT_ARGS, out]);
  return out;
}

/** "Respondent 3 · 2026-09-06 · 25–34 · Female · Lagos" from the caption fields chosen. */
function captionFor(video, profile, fields) {
  const values = {
    respondent: video.respondent,
    day: video.day,
    age: profile && profile.age_band,
    gender: profile && profile.gender,
    location: profile && profile.location,
  };
  return fields.map((field) => values[field]).filter((value) => value && value !== "Not recorded").join(" · ");
}

// Keep the whole supporting moment; trim only the padding around it.
function trimClip(clip, moment, maxSeconds) {
  if (!maxSeconds || clip.end - clip.start <= maxSeconds) return clip;
  const momentLength = moment.end - moment.start;
  if (momentLength >= maxSeconds) return { ...clip, start: moment.start, end: moment.end };
  const pad = (maxSeconds - momentLength) / 2;
  let start = Math.max(clip.start, moment.start - pad);
  let end = Math.min(clip.end, start + maxSeconds);
  if (end < moment.end) { end = moment.end; start = Math.max(clip.start, end - maxSeconds); }
  return { ...clip, start, end };
}

// Fit the reel into a total length: take each finding's first clip, then
// each finding's second, and so on, while they fit. Findings keep their order.
function fitToLength(findings, budget, fixedSeconds, settings) {
  if (!budget) return findings;
  let used = fixedSeconds;
  const taken = findings.map(() => 0);
  let added = true;
  while (added) {
    added = false;
    findings.forEach((finding, i) => {
      const next = finding.clips[taken[i]];
      if (!next) return;
      const cost = (next.end - next.start) + (taken[i] === 0 ? titleSecondsFor(finding.title, settings) : 0);
      if (used + cost > budget) return;
      used += cost;
      taken[i] += 1;
      added = true;
    });
  }
  // Never produce an empty reel because the budget is smaller than one clip.
  if (taken.every((n) => n === 0)) {
    const first = findings.findIndex((f) => f.clips.length);
    if (first >= 0) taken[first] = 1;
  }
  return findings.map((finding, i) => ({ ...finding, clips: finding.clips.slice(0, taken[i]) }));
}

/**
 * The reel's running order from a hydrated video summary: an intro card, per
 * point its title card and clips, then an outro card. Only videos marked
 * shareable (respondent gave media consent) are ever used.
 * options: { settings, profiles: Map(respondent_id -> { age_band, gender, location }) }
 */
function planReel(summary, studyName, options = {}) {
  const settings = reelSettings.normalize(options.settings);
  const profiles = options.profiles || new Map();
  const byId = new Map(summary.evidence.map(v => [v.clip_id, v]));
  const included = new Set();
  let findings = [];
  for (const point of summary.points) {
    const clips = [];
    for (const c of point.clips || []) {
      // Legacy video IDs have no evidence timestamp and cannot be rebuilt.
      const v = byId.get(c.clip_id);
      const moment = v?.moments?.find(m => m.id === c.moment_id);
      if (!v?.shareable || !v.file_path || !moment || !point.supports?.includes(moment.id)) throw new Error('A selected clip has no shareable timestamped evidence. Regenerate the summary.');
      if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end > v.duration || c.end <= c.start || c.start > moment.start || c.end < moment.end) throw new Error('Invalid clip boundaries.');
      const key = `${c.clip_id}:${c.start}:${c.end}`;
      if (included.has(key)) continue;
      included.add(key);
      const { start, end } = trimClip(c, moment, settings.length.max_clip_seconds);
      clips.push({ kind: 'clip', file_path: v.file_path, start, end,
        caption: captionFor(v, profiles.get(v.respondent_id), settings.captions.fields),
        subtitles: settings.captions.subtitles
          ? v.moments.filter(m => m.kind === 'speech' && m.start >= start && m.end <= end).map(m => ({ text: m.text, start: m.start - start, end: m.end - start }))
          : [] });
      if (settings.length.max_clips_per_finding && clips.length >= settings.length.max_clips_per_finding) break;
    }
    if (clips.length) findings.push({ title: point.point, subtitle: `${point.respondents.length} of ${point.respondent_base} respondents with evidence for this question`, clips });
  }
  const intro = { kind: 'title', title: settings.brand.intro_title || studyName || 'Video summary', subtitle: settings.brand.intro_subtitle };
  const outro = settings.brand.outro_text ? { kind: 'title', title: settings.brand.outro_text, subtitle: '' } : null;
  const fixed = titleSecondsFor(intro.title, settings) + (outro ? titleSecondsFor(outro.title, settings) : 0);
  findings = fitToLength(findings, settings.length.max_total_seconds, fixed, settings);
  const plan = [intro];
  for (const finding of findings) {
    if (!finding.clips.length) continue;
    plan.push({ kind: 'title', title: finding.title, subtitle: finding.subtitle }, ...finding.clips);
  }
  if (outro) plan.push(outro);
  return plan.some(s => s.kind === 'clip') ? plan : null;
}

// Background music under the joined reel, looped to its length and faded out,
// and (when ducking) pushed down automatically whenever someone speaks.
async function mixMusic(dir, reelFile, musicFile, music) {
  const seconds = await durationSeconds(reelFile);
  const out = path.join(dir, "reel-music.mp4");
  const level = (music.volume / 100).toFixed(2);
  const fadeStart = Math.max(0, (seconds || 0) - 2).toFixed(2);
  const bed = `[1:a]aresample=44100,aformat=channel_layouts=stereo,volume=${level}`;
  const graph = music.duck
    ? `[0:a]asplit=2[voice][key];${bed}[bed];[bed][key]sidechaincompress=threshold=0.03:ratio=12:attack=15:release=400[ducked];[voice][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,afade=t=out:st=${fadeStart}:d=2[a]`
    : `${bed}[bed];[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,afade=t=out:st=${fadeStart}:d=2[a]`;
  await run(["-i", reelFile, "-stream_loop", "-1", "-i", musicFile, "-filter_complex", graph, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-shortest", out], 300000);
  return out;
}

/**
 * Encode a plan into one MP4 on local disk. Returns { file, seconds, cleanup }.
 * options: { settings, logoPath, musicPath } -- stored media paths for the
 * study's uploaded logo and music, read through media storage.
 */
async function renderReel(plan, options = {}) {
  const settings = reelSettings.normalize(options.settings);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inicio-reel-"));
  const held = [];
  const cleanup = () => {
    for (const file of held) { try { file.cleanup(); } catch (_) { /* best effort */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  };
  try {
    const local = async (storedPath) => { const file = await materializeLocalFile(storedPath); held.push(file); return file.path; };
    const look = { settings, logoFile: settings.brand.logo && options.logoPath ? await local(options.logoPath) : null };
    const musicFile = settings.music.enabled && options.musicPath ? await local(options.musicPath) : null;
    const segments = [];
    let clips = 0;
    for (const [i, step] of plan.entries()) {
      if (step.kind === "title") {
        segments.push(await titleSegment(dir, i, step, look));
        continue;
      }
      const source = await materializeLocalFile(step.file_path);
      try {
        // Fail the build if a selected source is unreadable; do not publish a different story.
        segments.push(await clipSegment(dir, i, source.path, step, look));
        clips += 1;
      } finally {
        source.cleanup();
      }
    }
    if (!clips) throw new Error("None of the selected videos could be read.");
    const list = path.join(dir, "list.txt");
    fs.writeFileSync(list, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"));
    let file = path.join(dir, "reel.mp4");
    await run(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", file], 180000);
    if (musicFile) file = await mixMusic(dir, file, musicFile, settings.music);
    return { file, seconds: await durationSeconds(file), cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

module.exports = { planReel, renderReel, TITLE_SECONDS, assTime, assColor, captionFor, trimClip, fitToLength, titleSecondsFor };

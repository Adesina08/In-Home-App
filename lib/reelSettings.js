// Highlight-reel customisation: branding, format, music, captions and length.
//
// A study keeps default settings (studies.reel_settings_json). Each reel --
// the summary's main client reel (video_summaries.reel_settings_json) or an
// extra named cut (video_reels.settings_json) -- may store its own full
// settings; when it has none it uses the study defaults. Everything read from
// a form or the database goes through normalize(), so the renderer only ever
// sees known values.

const FORMATS = {
  landscape: { width: 1280, height: 720, label: "Landscape 16:9" },
  portrait: { width: 720, height: 1280, label: "Vertical 9:16" },
  square: { width: 720, height: 720, label: "Square 1:1" },
};
const CAPTION_FIELDS = ["respondent", "day", "age", "gender", "location"];
const CAPTION_POSITIONS = ["bottom", "top"];
const CAPTION_SIZES = ["small", "medium", "large"];
const HEX = /^#[0-9a-f]{6}$/i;

const DEFAULTS = Object.freeze({
  format: "landscape",
  brand: { background: "#1F2A44", text: "#FFFFFF", accent: "#C8D4EA", logo: true, logo_on_clips: false, intro_title: "", intro_subtitle: "Research findings · respondent evidence", outro_text: "" },
  music: { enabled: false, volume: 25, duck: true },
  captions: { subtitles: true, fields: ["respondent", "day"], position: "bottom", size: "medium" },
  length: { max_total_seconds: null, max_clips_per_finding: null, max_clip_seconds: null, title_seconds: 3 },
});

function parse(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

const bool = (value, fallback) => value === undefined || value === null || value === "" ? fallback : value === true || value === "1" || value === "on" || value === "true";
const text = (value, fallback, max = 120) => value === undefined || value === null ? fallback : String(value).replace(/[\r\n]+/g, " ").trim().slice(0, max);
const color = (value, fallback) => HEX.test(String(value || "")) ? String(value).toUpperCase() : fallback;
function bounded(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function optionalBounded(value, min, max) {
  if (value === undefined || value === null || value === "" || Number(value) === 0) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
}

/** A complete, valid settings object from anything (form body, stored JSON, partial). */
function normalize(input) {
  const s = parse(input) || {};
  const brand = s.brand || {}, music = s.music || {}, captions = s.captions || {}, length = s.length || {};
  let fields = captions.fields;
  if (typeof fields === "string") fields = [fields];
  return {
    format: FORMATS[s.format] ? s.format : DEFAULTS.format,
    brand: {
      background: color(brand.background, DEFAULTS.brand.background),
      text: color(brand.text, DEFAULTS.brand.text),
      accent: color(brand.accent, DEFAULTS.brand.accent),
      logo: bool(brand.logo, DEFAULTS.brand.logo),
      logo_on_clips: bool(brand.logo_on_clips, DEFAULTS.brand.logo_on_clips),
      intro_title: text(brand.intro_title, DEFAULTS.brand.intro_title),
      intro_subtitle: text(brand.intro_subtitle, DEFAULTS.brand.intro_subtitle),
      outro_text: text(brand.outro_text, DEFAULTS.brand.outro_text, 200),
    },
    music: {
      enabled: bool(music.enabled, DEFAULTS.music.enabled),
      volume: bounded(music.volume, DEFAULTS.music.volume, 0, 100),
      duck: bool(music.duck, DEFAULTS.music.duck),
    },
    captions: {
      subtitles: bool(captions.subtitles, DEFAULTS.captions.subtitles),
      fields: Array.isArray(fields) ? CAPTION_FIELDS.filter((f) => fields.includes(f)) : [...DEFAULTS.captions.fields],
      position: CAPTION_POSITIONS.includes(captions.position) ? captions.position : DEFAULTS.captions.position,
      size: CAPTION_SIZES.includes(captions.size) ? captions.size : DEFAULTS.captions.size,
    },
    length: {
      max_total_seconds: optionalBounded(length.max_total_seconds, 15, 1800),
      max_clips_per_finding: optionalBounded(length.max_clips_per_finding, 1, 20),
      max_clip_seconds: optionalBounded(length.max_clip_seconds, 3, 300),
      title_seconds: bounded(length.title_seconds, DEFAULTS.length.title_seconds, 2, 15),
    },
  };
}

// HTML checkboxes are absent when unticked, so a form post states every
// boolean explicitly through a hidden "0" before the checkbox.
function fromForm(body) {
  const b = body || {};
  const last = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
  return normalize({
    format: b.format,
    brand: { background: b.brand_background, text: b.brand_text, accent: b.brand_accent, logo: last(b.brand_logo) ?? "0", logo_on_clips: last(b.brand_logo_on_clips) ?? "0", intro_title: b.brand_intro_title, intro_subtitle: b.brand_intro_subtitle, outro_text: b.brand_outro_text },
    music: { enabled: last(b.music_enabled) ?? "0", volume: b.music_volume, duck: last(b.music_duck) ?? "0" },
    captions: { subtitles: last(b.captions_subtitles) ?? "0", fields: b.captions_fields || [], position: b.captions_position, size: b.captions_size },
    length: { max_total_seconds: b.length_max_total_seconds, max_clips_per_finding: b.length_max_clips_per_finding, max_clip_seconds: b.length_max_clip_seconds, title_seconds: b.length_title_seconds },
  });
}

/** The study's defaults: settings plus its uploaded logo and music. */
function studyDefaults(study) {
  return { settings: normalize(study && study.reel_settings_json), logoPath: (study && study.reel_logo_path) || null, musicPath: (study && study.reel_music_path) || null };
}

/** What a reel renders with: its own settings when saved, else the study's. */
function effective(study, ownSettings) {
  const defaults = studyDefaults(study);
  return { ...defaults, settings: ownSettings ? normalize(ownSettings) : defaults.settings, inherited: !ownSettings };
}

module.exports = { DEFAULTS, FORMATS, CAPTION_FIELDS, CAPTION_POSITIONS, CAPTION_SIZES, normalize, fromForm, studyDefaults, effective };

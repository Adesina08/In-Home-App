// Record and edit marketing videos against the demo server (./serve.sh).
//   node run.js study-creation              record + edit one video
//   node run.js study-creation --edit-only  re-edit the last recording
//   node run.js all --music path/to/track.mp3
const path = require('path');
const { compose } = require('./compose');

const VIDEOS = {
  rewards: { kicker: 'Respondent rewards', title: 'Rewards that keep diaries going', subtitle: 'Set milestones, celebrate progress in the app, and track every payment.', parts: ['rewards-staff', 'rewards-app'] },
  'ai-entry': { kicker: 'AI-assisted diary', title: 'Just talk. AI fills in the diary.', subtitle: 'Respondents record a short video; answers are extracted and checked by your team.',
    parts: ['ai-entry-phone', 'ai-entry-review'], voiceovers: [{ part: 'ai-entry-phone', mark: 'mic-open', delay: 3.0, file: path.join(__dirname, '.work', 'voices', 'ai-entry.wav') }] },
  'results-insights': { kicker: 'For research teams and clients', title: 'From diary entries to insight', subtitle: 'Live dashboards, built-in quality checks, AI summaries and a client portal.' },
  'diary-entry': { kicker: 'For respondents', title: 'A diary entry in under a minute', subtitle: 'Tap-to-answer questions, their own words and live photo evidence.' },
  'respondent-onboarding': { kicker: 'For respondents', title: 'Joining a study takes two minutes', subtitle: 'One link: consent, a quick profile, a verified phone and a private login.' },
  'study-creation': { kicker: 'For research teams', title: 'Create a study in minutes', subtitle: 'Set up, build the questionnaire and invite respondents — all in one place.' },
};

(async () => {
  const args = process.argv.slice(2);
  const musicAt = args.indexOf('--music');
  // Default to the original bed from music.js; --music swaps in any licensed track, --no-music for silence.
  const bed = path.join(__dirname, '.work', 'music.wav');
  const music = musicAt > -1 ? path.resolve(args[musicAt + 1]) : (!args.includes('--no-music') && require('fs').existsSync(bed) ? bed : null);
  const names = args[0] === 'all' ? Object.keys(VIDEOS) : [args[0]];
  for (const name of names) {
    if (!VIDEOS[name]) throw new Error(`Unknown video "${name}". Choose: ${Object.keys(VIDEOS).join(', ')}, all`);
    if (!args.includes('--edit-only')) await require(`./flows/${name}`)();
    await compose(name, { ...VIDEOS[name], music });
  }
})().catch((e) => { console.error(e); process.exit(1); });

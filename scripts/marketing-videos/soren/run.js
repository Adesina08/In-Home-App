// Record and edit the Soren marketing videos against the live platform.
//   SOREN_USER=… SOREN_PASS=… node soren/run.js project-creation
//   node soren/run.js project-creation --edit-only
//   DRY=1 node soren/run.js project-creation   rehearse without creating anything
const fs = require('fs');
const path = require('path');
const { compose } = require('../compose');
const { WORK } = require('../config');
const { ensureLogin } = require('./common');

const BRAND = { brand: 'INICIO InsightsFlow', steps: ['01 Project', '02 Sessions', '03 Responses', '04 Analysis'], outroTitle: 'Research, end to end.' };
const VIDEOS = {
  'project-creation': { kicker: 'For research teams', title: 'Set up a full study in minutes', subtitle: 'Upload your questionnaire, add an AI discussion guide and choose what to learn about participants.' },
  // Recorded live with soren/live.js (a real WhatsApp code is read out mid-flow), so edit-only here.
  'respondent-onboarding': { kicker: 'For participants', title: 'Joining a study takes a minute', subtitle: 'One link, a WhatsApp code and a short profile. No app or password needed.', live: true },
  'entry-bot': { kicker: 'For participants', title: 'A diary entry in Bot Mode', subtitle: 'One question at a time: tap, rate, type. Done in about a minute.', live: true },
  // Three takes: text answer, then audio (fake mic), then video (fake camera + mic); the voices are laid back in.
  'entry-ai': { kicker: 'For participants', title: 'An AI interview, any way they like', subtitle: 'The AI interviewer follows your guide and probes. Participants answer by text, voice or video.', live: true,
    parts: ['soren-entry-ai', 'soren-entry-ai-2', 'soren-entry-ai-3'],
    voiceovers: [
      { part: 'soren-entry-ai-2', mark: 'voice-brand', delay: 0, file: path.join(WORK, 'voices', 'soren-brand.wav') },
      { part: 'soren-entry-ai-3', mark: 'voice-price', delay: 0, file: path.join(WORK, 'voices', 'soren-price.wav') },
    ] },
  'analysis': { kicker: 'For research teams and clients', title: 'From responses to a client report', subtitle: 'Live dashboards, sentiment, crosstabs, AI-written reports and transcribed interviews.', live: true },
  'session-creation': { kicker: 'For research teams', title: 'Sessions in Bot or AI Bot mode', subtitle: 'Run a questionnaire or an AI-moderated conversation, each with its own shareable link.' },
};
// Every video above as one film: one intro and outro, the recordings back to back.
VIDEOS.full = {
  kicker: 'Product tour', title: 'Research, end to end', subtitle: 'Set up a study, run Bot and AI interviews, onboard participants and turn their answers into a client report.',
  combined: true,
  parts: ['project-creation', 'session-creation', 'respondent-onboarding', 'entry-bot', 'entry-ai', 'analysis'].flatMap((n) => VIDEOS[n].parts || [`soren-${n}`]),
  voiceovers: VIDEOS['entry-ai'].voiceovers,
};

(async () => {
  const args = process.argv.slice(2);
  // Soren has its own bed (node music.js soren); --music swaps in any licensed track, --no-music for silence.
  const bed = path.join(WORK, 'soren-music.wav');
  const musicAt = args.indexOf('--music');
  const music = musicAt > -1 ? path.resolve(args[musicAt + 1]) : (!args.includes('--no-music') && fs.existsSync(bed) ? bed : null);
  const names = args[0] === 'all' ? Object.keys(VIDEOS).filter((n) => n !== 'full') : [args[0]];
  for (const name of names) {
    if (!VIDEOS[name]) throw new Error(`Unknown video "${name}". Choose: ${Object.keys(VIDEOS).join(', ')}, all`);
    if (VIDEOS[name].combined) { await compose(`soren-${name}`, { ...BRAND, ...VIDEOS[name], music }); continue; }
    if (VIDEOS[name].live && !fs.existsSync(path.join(WORK, 'raw', `soren-${name}`, 'cues.json'))) throw new Error(`Record ${name} first with soren/live.js.`);
    if (!args.includes('--edit-only') && !VIDEOS[name].live) { await ensureLogin(); await require(`./flows/${name}`)(); }
    await compose(`soren-${name}`, { ...BRAND, ...VIDEOS[name], parts: VIDEOS[name].parts || [`soren-${name}`], music });
  }
})().catch((e) => { console.error(e); process.exit(1); });

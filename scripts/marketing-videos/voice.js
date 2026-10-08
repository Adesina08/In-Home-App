// AI voices (Gemini text-to-speech) for the respondent videos in the demo.
// Stock clips are silent; each gets a first-person diary line, so the app's
// real video analysis has speech to transcribe and summarise.
//   node voice.js          -> .work/voices/<name>.wav for every line below
const fs = require('fs');
const path = require('path');
const { APP, WORK } = require('./config');

const KEY = require(path.join(APP, 'node_modules', 'dotenv')).parse(fs.readFileSync(path.join(APP, '.env'))).GEMINI_API_KEY;
// gemini-3.8-flash-tts read the style cue aloud; 2.5 follows it as direction only.
const MODELS = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'];
const STYLE = (who) => `Say naturally, like ${who} recording a quick diary video on their phone, in relaxed Nigerian English:`;

// name -> stock clip it is laid over (see compose of media in enrich.js), voice, speaker, line.
const LINES = {
  'ai-entry': { voice: 'Aoede', who: 'a warm Nigerian woman in her thirties at home', text: "Good morning! I'm having a cold Sunrise Malt with my breakfast here at home, with my family. I bought it at the supermarket. My kids love it, so it's always in the fridge." },
  'clip-9830': { voice: 'Leda', who: 'a calm Nigerian woman in her forties', text: "Evening time. I've made a warm malt drink with a little milk. It helps me relax after work. I buy it from the shop near my house." },
  'clip-31672': { voice: 'Kore', who: 'a young Nigerian professional woman', text: "Just finished lunch at the office, so I'm having a cold Maltwell. It's my small treat in the afternoon, before the next meeting." },
  'clip-2339': { voice: 'Charon', who: 'a friendly Nigerian man in his thirties', text: "Lunch with my wife at our favourite spot. We ordered two Kora Malts with the food. Honestly, it goes well with rice." },
  'clip-172686': { voice: 'Zephyr', who: 'a cheerful Nigerian mother', text: "Dinner with the children. Everybody gets a small glass of Sunrise Malt on Sundays. It's a family thing for us now." },
  'clip-7647': { voice: 'Achernar', who: 'a busy Nigerian mother in the morning', text: "Breakfast before school. I mix the malt with a bit of milk for my son. He won't finish his food without it." },
  'clip-169349': { voice: 'Puck', who: 'a relaxed Nigerian father on a Saturday', text: "Saturday breakfast with the whole family. Bread, eggs and Royal Grain for everyone. We buy it in packs at the supermarket, it lasts the week." },
};

async function speak(name, { voice, who, text }) {
  const out = path.join(WORK, 'voices', `${name}.wav`);
  if (fs.existsSync(out)) return console.log(`${name}: cached`);
  let lastError;
  for (const model of MODELS) for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(150000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${STYLE(who)}\n\n${text}` }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
        }),
      });
      const data = await res.json();
      const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!res.ok || !part) throw new Error(`${model} ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
      const pcm = Buffer.from(part.inlineData.data, 'base64');
      const rate = Number((/rate=(\d+)/.exec(part.inlineData.mimeType) || [])[1]) || 24000;
      const head = Buffer.alloc(44);
      head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
      head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
      head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.concat([head, pcm]));
      return console.log(`${name}: ${(pcm.length / 2 / rate).toFixed(1)}s via ${model}`);
    } catch (e) {
      lastError = e;
      // The free tier allows only a few speech requests per minute; wait it out.
      if (/ 429:/.test(e.message)) { console.warn(`${name}: rate limited, waiting 40s`); await new Promise((r) => setTimeout(r, 40000)); continue; }
      console.warn(`${name}: ${e.message}`); break;
    }
  }
  throw lastError;
}

module.exports = { LINES };
if (require.main === module) {
  (async () => { for (const [name, line] of Object.entries(LINES)) await speak(name, line); })().catch((e) => { console.error(e.message); process.exit(1); });
}

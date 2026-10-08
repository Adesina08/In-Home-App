// Generates a real AI study summary of the fictional demo data (Gemini) and
// approves it for the client view, so the results video shows genuine output.
// Only the demo database is read; only fictional demo data is sent to Gemini.
const fs = require('fs');
const path = require('path');
const { APP } = require('./config');
const dotenv = require(path.join(APP, 'node_modules', 'dotenv'));
if (process.env.MONGODB_URI || !String(process.env.LOCAL_DB_PATH).includes('/marketing-videos/.work/')) throw new Error('Refusing: not the demo database.');
const real = dotenv.parse(fs.readFileSync(path.join(APP, '.env')));
if (!real.GEMINI_API_KEY) { console.log('No GEMINI_API_KEY in .env; skipping the AI summary.'); process.exit(0); }
process.env.AI_SUMMARY_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = real.GEMINI_API_KEY;
if (real.GEMINI_MODEL) process.env.GEMINI_MODEL = real.GEMINI_MODEL;
const store = require(path.join(APP, 'lib', 'store'));
const aiSummary = require(path.join(APP, 'lib', 'aiSummary'));

(async () => {
  await store.connect();
  const row = await aiSummary.generateSummary(1, { generatedBy: 'research@inicio.demo', force: true });
  await store.update('ai_summaries', { id: row.id }, { review_status: 'approved', approved_by: 'research@inicio.demo', approved_at: store.nowSql(), client_narrative: row.narrative });
  console.log(`AI summary ${row.id} (${row.provider}) approved: ${row.narrative.slice(0, 160)}...`);
  await store.close();
})().catch((e) => { console.error('AI summary failed:', e.message); process.exit(1); });

// In-process periodic trigger for the reminder engine (lib/reminders.js). The
// engine itself has always been safe to call any time -- it only creates a
// reminder for a respondent who's actually due/missed and never double-sends
// (see the "existing scheduled reminder" check inside it) -- what was missing
// was anything calling it on its own. Previously it only ran when a staff
// member clicked "Run Reminder Engine" on the dashboard; this makes that
// automatic, on an interval, so a respondent's push notification / WhatsApp
// reminder actually arrives close to when the study's own due/missed-hours
// settings (Admin > Study Settings > Reminder Schedule) say it should.
//
// A single Node process with setInterval is intentionally simple -- this is
// the same "prototype now, real queue/cron later if this needs to survive
// multiple app instances" tradeoff already documented in PRODUCTION_READINESS.md
// for the rest of the app. It's guarded against overlapping runs (a slow run
// won't stack a second one on top of itself) and against one bad run crashing
// the process (errors are logged, never thrown).
const { runReminderEngine } = require("./reminders");
const { triggerDueEndValidations } = require("./endValidationTrigger");

const INTERVAL_MS = parseInt(process.env.REMINDER_ENGINE_INTERVAL_MINUTES || "15", 10) * 60 * 1000;

let running = false;

async function tick() {
  if (running) return; // previous run still in flight -- skip this tick rather than overlap
  running = true;
  try {
    const result = await runReminderEngine();
    if (result.created > 0) {
      console.log(`Reminder engine (auto): created ${result.created}, suppressed ${result.suppressed}`);
    }
    const ended = await triggerDueEndValidations();
    if (ended.triggered > 0) {
      console.log(`End-of-diary validation (auto): triggered for ${ended.triggered} respondent(s)`);
    }
  } catch (e) {
    console.error("Reminder engine (auto) run failed:", e.message);
  } finally {
    running = false;
  }
}

function start() {
  if (process.env.REMINDER_ENGINE_AUTORUN === "false") {
    console.log("Reminder engine auto-run disabled (REMINDER_ENGINE_AUTORUN=false).");
    return;
  }
  setInterval(tick, INTERVAL_MS);
  console.log(`Reminder engine will auto-run every ${INTERVAL_MS / 60000} minute(s).`);
}

module.exports = { start };

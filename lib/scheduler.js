// In-process periodic trigger for the reminder engine (lib/reminders.js) and
// the end-of-diary validation trigger (lib/endValidationTrigger.js). The
// engine itself has always been safe to call any time -- it only creates a
// reminder for a respondent who's actually due/missed and never double-sends
// (see the "existing scheduled reminder" check inside it) -- what was missing
// was anything calling it on its own. Previously it only ran when a staff
// member clicked "Run Reminder Engine" on the dashboard; this makes that
// automatic, on an interval, so a respondent's push notification / WhatsApp
// reminder actually arrives close to when the study's own due/missed-hours
// settings (Admin > Study Settings > Reminder Schedule) say it should.
//
// The interval is re-read from lib/systemSettings.js before every cycle
// (self-rescheduling setTimeout, not a fixed setInterval) specifically so a
// change made on Admin > System Settings takes effect on the NEXT tick, not
// after a redeploy or an App Service restart. That was the actual ask: the
// interval used to only be reachable via an Azure environment variable, which
// meant the person setting up a study had no way to change it at all.
//
// A single Node process with a timer is intentionally simple -- this is the
// same "prototype now, real queue/cron later if this needs to survive
// multiple app instances" tradeoff already documented in
// PRODUCTION_READINESS.md for the rest of the app. It's guarded against
// overlapping runs (a slow run won't stack a second one on top of itself) and
// against one bad run crashing the process (errors are logged, never thrown).
const { runReminderEngine } = require("./reminders");
const { triggerDueEndValidations } = require("./endValidationTrigger");
const { getSchedulerIntervalMinutes } = require("./systemSettings");

let running = false;
let timer = null;

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

async function scheduleNext() {
  // Read fresh every cycle. If the settings row or the database itself is
  // briefly unreachable, fall back to 15 minutes rather than let a read
  // failure silently stop the scheduler altogether.
  let minutes = 15;
  try {
    minutes = await getSchedulerIntervalMinutes();
  } catch (e) {
    console.error("Could not read scheduler interval, using 15 minute default:", e.message);
  }
  timer = setTimeout(async () => {
    await tick();
    scheduleNext();
  }, minutes * 60 * 1000);
}

function start() {
  if (process.env.REMINDER_ENGINE_AUTORUN === "false") {
    console.log("Reminder engine auto-run disabled (REMINDER_ENGINE_AUTORUN=false).");
    return;
  }
  scheduleNext();
  console.log("Reminder engine will auto-run on an interval set from Admin > System Settings (default 15 minutes).");
}

// Test/ops escape hatch -- not used by the app itself.
function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { start, stop };

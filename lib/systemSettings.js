// Platform-wide operational settings, editable from the app itself rather
// than requiring access to Azure App Service's environment variables.
//
// Currently holds one setting: how often the background scheduler
// (lib/scheduler.js) checks for reminders and end-of-diary triggers that are
// due. That used to be fixed at process start from
// REMINDER_ENGINE_INTERVAL_MINUTES, which only whoever has Azure access could
// change -- not whoever actually set the study up and knows what cadence
// makes sense for it.
//
// Modelled as a single row rather than one setting per study: the scheduler
// is one Node process serving every study, so its polling interval is
// necessarily a platform-level choice, not a per-study one. A study's own
// reminder TIMES (first/second reminder, quiet hours) are already
// per-study, in Study Settings -- this is a different, coarser thing: how
// often the engine wakes up to check whether any of those times have arrived.

const store = require("./store");

const MIN_MINUTES = 1;
const MAX_MINUTES = 120;

function clamp(n) {
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, n));
}

async function getRow() {
  const existing = await store.findOne("system_settings", {});
  if (existing) return existing;
  // First run on a fresh database: seed from the environment variable so
  // nothing changes for an existing deployment until someone actively opens
  // the settings screen and changes it.
  const envParsed = parseInt(process.env.REMINDER_ENGINE_INTERVAL_MINUTES, 10);
  const envDefault = clamp(Number.isNaN(envParsed) ? 15 : envParsed);
  const { id } = await store.insert("system_settings", { scheduler_interval_minutes: envDefault });
  return { id, scheduler_interval_minutes: envDefault };
}

async function getSchedulerIntervalMinutes() {
  const row = await getRow();
  return clamp(row.scheduler_interval_minutes || 15);
}

async function setSchedulerIntervalMinutes(minutes, actorEmail) {
  // NOT `parsed || 15` -- 0 is a legitimate (if too-low) parsed value and is
  // falsy in JS, so that form silently replaced "0" with the default instead
  // of clamping it up to MIN_MINUTES the way every other out-of-range value
  // is handled. Only a genuinely unparseable input should fall back to 15.
  const parsed = parseInt(minutes, 10);
  const n = clamp(Number.isNaN(parsed) ? 15 : parsed);
  const row = await getRow();
  await store.update("system_settings", { id: row.id }, {
    scheduler_interval_minutes: n,
    updated_at: store.nowSql(),
    updated_by: actorEmail || null,
  });
  return n;
}

module.exports = { getSchedulerIntervalMinutes, setSchedulerIntervalMinutes, MIN_MINUTES, MAX_MINUTES };

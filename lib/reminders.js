// Reminder engine. Reads schedule/cadence from study config (Developer > Reminder
// Schedule) rather than a hardcoded cadence. In production this function is what
// a real scheduler (cron / queue worker) should call periodically — see
// PRODUCTION_READINESS.md section B8 (monitoring) for how to supervise that job.
// In this prototype it is triggered manually from Admin > "Run Reminder Engine".

const store = require("./store");
const { getProvider } = require("./whatsapp");
const push = require("./push");
const { logAudit } = require("./audit");
const { respondentDiaryUrlFromConfig } = require("./urls");
const whatsappLinks = require("./whatsappLinks");
const whatsappFlow = require("./whatsappFlow");

// A respondent is reminded on the channel they take part through: WhatsApp
// participants on WhatsApp. Mobile app users get none from here -- the app
// schedules its own on-device notifications from reminderThresholds() (served
// on /mobile/api/respondents/:id/home), so they need no push setup or opt-in.
// The study's configured channels only apply to respondents who haven't
// chosen a mode yet.
function reminderChannelsFor(respondent, study) {
  if (respondent.chosen_mode === "whatsapp") return ["whatsapp"];
  if (respondent.chosen_mode === "app") return [];
  return Array.isArray(study.reminder_channels) && study.reminder_channels.length
    ? study.reminder_channels
    : [study.default_reminder_channel || "whatsapp"];
}

function reminderThresholds(study) {
  const defaultDue = { realtime: 12, daily: 24, weekly: 168, monthly: 720 }[study.diary_mode] || 24;
  const dueHours = Number(study.reminder_due_hours) || defaultDue;
  const missedHours = Number(study.reminder_missed_hours) || dueHours * 2;
  return { dueHours, missedHours };
}

// Habit-timed app reminders (expo-mobile/src/reminders.ts) run as an
// experiment: one respondent in five keeps fixed timing as a control, chosen by
// id so the arm is stable across devices and needs no stored assignment.
const TIMING_CONTROL_EVERY = 5;
// Entries before habit timing shipped don't count towards the comparison.
const TIMING_SINCE = Date.parse("2026-10-12T00:00:00Z");

function reminderTiming(respondent) {
  return Number(respondent.id) % TIMING_CONTROL_EVERY === 0 ? "fixed" : "habit";
}

// diary_records times are UTC 'YYYY-MM-DD HH:MM:SS'.
const recordTime = (r) => Date.parse(String(r.submit_time || r.entry_time || "").replace(" ", "T") + "Z");

// Compares the two arms over app respondents: the share of diary intervals
// that closed within the reminder threshold (each gap between entries, plus a
// still-open gap once it's already late), and entries per respondent.
function reminderTimingComparison(study, respondents, records, now = Date.now()) {
  const { dueHours } = reminderThresholds(study);
  const end = Math.min(now, study.end_date ? Date.parse(`${study.end_date}T23:59:59Z`) : Infinity);
  const arms = { habit: { respondents: 0, entries: 0, intervals: 0, onTime: 0 }, fixed: { respondents: 0, entries: 0, intervals: 0, onTime: 0 } };
  const byRespondent = new Map();
  for (const r of records) {
    const at = recordTime(r);
    if (r.status !== "submitted" || r.is_practice || !(at >= TIMING_SINCE)) continue;
    byRespondent.set(r.respondent_id, [...(byRespondent.get(r.respondent_id) || []), at]);
  }
  for (const respondent of respondents) {
    if (respondent.chosen_mode !== "app") continue;
    const arm = arms[reminderTiming(respondent)];
    const times = (byRespondent.get(respondent.id) || []).sort((a, b) => a - b);
    arm.respondents++;
    arm.entries += times.length;
    times.slice(1).forEach((t, i) => { arm.intervals++; if (t - times[i] <= dueHours * 36e5) arm.onTime++; });
    if (times.length && end - times[times.length - 1] > dueHours * 36e5) arm.intervals++;
  }
  return Object.fromEntries(Object.entries(arms).map(([key, a]) => [key, {
    respondents: a.respondents,
    entriesPerRespondent: a.respondents ? a.entries / a.respondents : null,
    onTimeRate: a.intervals ? a.onTime / a.intervals : null,
    intervals: a.intervals,
  }]));
}

async function runReminderEngine() {
  const studies = await store.find("studies", { status: "live" });
  const provider = getProvider();
  let created = 0;
  let suppressed = 0;

  for (const study of studies) {
    const respondents = await store.find("respondents", {
      study_id: study.id,
      activation_status: { $in: ["active", "activated"] },
    });

    for (const r of respondents) {
      // entry_time is stored as 'YYYY-MM-DD HH:MM:SS', so a plain descending
      // string sort is the same order the old datetime(entry_time) DESC gave.
      const lastRecord = await store.findOne(
        "diary_records",
        { respondent_id: r.id },
        { sort: { entry_time: -1 } }
      );

      const hoursSinceLast = lastRecord ? (Date.now() - new Date(lastRecord.entry_time)) / 36e5 : 999;
      const { dueHours: dueThreshold, missedHours: missedThreshold } = reminderThresholds(study);

      const completedRecently = lastRecord && lastRecord.status === "submitted" && hoursSinceLast < dueThreshold;

      if (completedRecently) {
        // suppression after completion
        await store.update("reminders", { respondent_id: r.id, status: "scheduled" }, { status: "suppressed" });
        suppressed++;
        continue;
      }

      if (hoursSinceLast >= dueThreshold) {
        const requirement = hoursSinceLast >= missedThreshold ? "missed" : "due";
        const configuredChannels = reminderChannelsFor(r, study);
        const cycleKey = lastRecord ? `record:${lastRecord.id}` : "no-record";
        for (const channel of configuredChannels) {
          const existing = await store.findOne("reminders", { respondent_id: r.id, requirement, channel, cycle_key: cycleKey });
          if (existing) continue;
          const { id } = await store.insert("reminders", {
            respondent_id: r.id,
            requirement,
            channel,
            cycle_key: cycleKey,
            status: "scheduled",
          });
          created++;
          let result = { ok: true };
          if (channel === "whatsapp" || channel === "sms" || channel === "email") {
            const nativeFlow = channel === "whatsapp"
              ? await whatsappFlow.sendReminder({ respondent: r, study, requirement })
              : null;
            result = nativeFlow || await provider.send({
              respondentId: r.id,
              to: r.contact,
              channel,
              template: requirement === "missed" ? "diary_missed_reminder" : "diary_due_reminder",
              // A reminder with no way to act on it wastes the message. The
              // link is omitted rather than guessed when APP_BASE_URL isn't
              // set (see lib/urls.js) -- the engine has no request to derive
              // the public hostname from.
              variables: {
                name: r.name,
                study: study.name,
                link: channel === "whatsapp"
                  ? whatsappLinks.chatUrl(r.unique_token)
                  : respondentDiaryUrlFromConfig(r.unique_token),
              },
            });
          } else {
            // "in-app" channel: a real push notification (Web Push/VAPID) to
            // any device this respondent has enabled reminders on -- a no-op
            // if push isn't configured (no VAPID keys) or they haven't opted in
            // on any device yet, so this never throws or blocks the loop.
            const pushed = await push.sendToRespondent(r.id, {
              title: `${study.name} — diary reminder`,
              body:
                requirement === "missed"
                  ? `Hi${r.name ? " " + r.name : ""}, you're overdue to log your consumption diary. Please add an entry when you can.`
                  : `Hi${r.name ? " " + r.name : ""}, it's time to log your consumption diary.`,
              url: `/r/${r.unique_token}`,
              tag: `inicio-reminder-${r.id}`,
            });
            result = { ok: pushed.sent > 0, error: pushed.sent ? null : pushed.reason || "No subscribed device." };
          }
          await store.update("reminders", { id }, result.ok ? { status: "sent", sent_time: store.nowSql(), error: null } : { status: "failed", error: result.error || "Delivery failed." });
        }
      }
    }
  }

  logAudit("reminder-engine", "run", "reminders", null, { created, suppressed });
  return { created, suppressed };
}

module.exports = { runReminderEngine, reminderChannelsFor, reminderThresholds, reminderTiming, reminderTimingComparison };

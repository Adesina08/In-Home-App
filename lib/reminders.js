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
      const defaultDue = { realtime: 12, daily: 24, weekly: 168, monthly: 720 }[study.diary_mode] || 24;
      const dueThreshold = study.reminder_due_hours || defaultDue;
      const missedThreshold = study.reminder_missed_hours || dueThreshold * 2;

      const completedRecently = lastRecord && lastRecord.status === "submitted" && hoursSinceLast < dueThreshold;

      if (completedRecently) {
        // suppression after completion
        await store.update("reminders", { respondent_id: r.id, status: "scheduled" }, { status: "suppressed" });
        suppressed++;
        continue;
      }

      if (hoursSinceLast >= dueThreshold) {
        const requirement = hoursSinceLast >= missedThreshold ? "missed" : "due";
        const existing = await store.findOne("reminders", { respondent_id: r.id, status: "scheduled" });
        if (!existing) {
          const channel = r.preferred_channel === "whatsapp" ? "whatsapp" : study.default_reminder_channel === "whatsapp" ? "whatsapp" : "in-app";
          const { id } = await store.insert("reminders", {
            respondent_id: r.id,
            requirement,
            channel,
            status: "scheduled",
          });
          created++;

          if (channel === "whatsapp") {
            await provider.send({
              respondentId: r.id,
              to: r.contact,
              template: requirement === "missed" ? "diary_missed_reminder" : "diary_due_reminder",
              // A reminder with no way to act on it wastes the message. The
              // link is omitted rather than guessed when APP_BASE_URL isn't
              // set (see lib/urls.js) -- the engine has no request to derive
              // the public hostname from.
              variables: { name: r.name, study: study.name, link: respondentDiaryUrlFromConfig(r.unique_token) },
            });
          } else {
            // "in-app" channel: a real push notification (Web Push/VAPID) to
            // any device this respondent has enabled reminders on -- a no-op
            // if push isn't configured (no VAPID keys) or they haven't opted in
            // on any device yet, so this never throws or blocks the loop.
            await push.sendToRespondent(r.id, {
              title: `${study.name} — diary reminder`,
              body:
                requirement === "missed"
                  ? `Hi${r.name ? " " + r.name : ""}, you're overdue to log your consumption diary. Please add an entry when you can.`
                  : `Hi${r.name ? " " + r.name : ""}, it's time to log your consumption diary.`,
              url: `/r/${r.unique_token}`,
              tag: `inicio-reminder-${r.id}`,
            });
          }
          await store.update("reminders", { id }, { status: "sent", sent_time: store.nowSql() });
        }
      }
    }
  }

  logAudit("reminder-engine", "run", "reminders", null, { created, suppressed });
  return { created, suppressed };
}

module.exports = { runReminderEngine };

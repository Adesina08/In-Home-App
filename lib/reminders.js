// Reminder engine. Reads schedule/cadence from study config (Developer > Reminder
// Schedule) rather than a hardcoded cadence. In production this function is what
// a real scheduler (cron / queue worker) should call periodically — see
// PRODUCTION_READINESS.md section B8 (monitoring) for how to supervise that job.
// In this prototype it is triggered manually from Admin > "Run Reminder Engine".

const db = require("./db");
const { getProvider } = require("./whatsapp");
const { logAudit } = require("./audit");

async function runReminderEngine() {
  const studies = db.prepare("SELECT * FROM studies WHERE status = 'live'").all();
  const provider = getProvider();
  let created = 0;
  let suppressed = 0;

  for (const study of studies) {
    const respondents = db
      .prepare("SELECT * FROM respondents WHERE study_id = ? AND activation_status IN ('active','activated')")
      .all(study.id);

    for (const r of respondents) {
      const lastRecord = db
        .prepare(
          `SELECT * FROM diary_records WHERE respondent_id = ? ORDER BY datetime(entry_time) DESC LIMIT 1`
        )
        .get(r.id);

      const hoursSinceLast = lastRecord ? (Date.now() - new Date(lastRecord.entry_time)) / 36e5 : 999;
      const defaultDue = { realtime: 12, daily: 24, weekly: 168, monthly: 720 }[study.diary_mode] || 24;
      const dueThreshold = study.reminder_due_hours || defaultDue;
      const missedThreshold = study.reminder_missed_hours || dueThreshold * 2;

      const completedRecently = lastRecord && lastRecord.status === "submitted" && hoursSinceLast < dueThreshold;

      if (completedRecently) {
        // suppression after completion
        db.prepare(
          `UPDATE reminders SET status = 'suppressed' WHERE respondent_id = ? AND status = 'scheduled'`
        ).run(r.id);
        suppressed++;
        continue;
      }

      if (hoursSinceLast >= dueThreshold) {
        const requirement = hoursSinceLast >= missedThreshold ? "missed" : "due";
        const existing = db
          .prepare(`SELECT * FROM reminders WHERE respondent_id = ? AND status = 'scheduled'`)
          .get(r.id);
        if (!existing) {
          const channel = r.preferred_channel === "whatsapp" ? "whatsapp" : study.default_reminder_channel === "whatsapp" ? "whatsapp" : "in-app";
          const info = db
            .prepare(`INSERT INTO reminders (respondent_id, requirement, channel, status) VALUES (?, ?, ?, 'scheduled')`)
            .run(r.id, requirement, channel);
          created++;

          if (channel === "whatsapp") {
            await provider.send({
              respondentId: r.id,
              to: r.contact,
              template: requirement === "missed" ? "diary_missed_reminder" : "diary_due_reminder",
              variables: { name: r.name, study: study.name },
            });
          }
          db.prepare(`UPDATE reminders SET status = 'sent', sent_time = datetime('now') WHERE id = ?`).run(info.lastInsertRowid);
        }
      }
    }
  }

  logAudit("reminder-engine", "run", "reminders", null, { created, suppressed });
  return { created, suppressed };
}

module.exports = { runReminderEngine };

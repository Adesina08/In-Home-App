// On-device diary reminders for app respondents. The server's reminder engine
// skips app users (lib/reminders.js); instead the app schedules local
// notifications from the study's due/missed thresholds (served on the home
// payload) counted from the respondent's latest entry. Every call cancels and
// re-plans, so opening the study or submitting an entry pushes reminders out.
// Local notifications need no Firebase or push server -- only the OS
// notification permission, which is requested automatically (Android 13+
// shows its one-time system prompt; older Android grants it by default).
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

export type ReminderPlan = { dueHours: number; missedHours: number; active: boolean; endDate: string | null };

const CHANNEL_ID = "diary-reminders";
const PREFIX = "diary-reminder-";
const HOUR = 36e5;
// Overdue nudges after the first "missed" one, spaced one due-interval apart.
const MISSED_FOLLOW_UPS = 4;

if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

async function ensurePermission() {
  // The channel must exist before asking: on Android 13+ creating it is
  // what lets the system permission prompt appear.
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Diary reminders",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

export async function cancelDiaryReminders(respondentId?: number) {
  if (Platform.OS === "web") return;
  const prefix = respondentId == null ? PREFIX : `${PREFIX}${respondentId}-`;
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(scheduled
    .filter((n) => n.identifier.startsWith(prefix))
    .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)));
}

// Server timestamps are UTC 'YYYY-MM-DD HH:MM:SS'; queued packets use ISO.
function parseTime(value?: string | null) {
  if (!value) return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "Z" : value);
}

export function latestEntryTime(records: { status: string; entryTime?: string | null; submitTime?: string | null }[], queuedAt: string[] = []) {
  const times = [
    ...records.filter((r) => r.status === "submitted").map((r) => parseTime(r.submitTime || r.entryTime)),
    ...queuedAt.map(parseTime),
  ].filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

export async function scheduleDiaryReminders({ respondentId, studyName, name, plan, lastEntryAt }: {
  respondentId: number; studyName: string; name?: string | null; plan?: ReminderPlan | null; lastEntryAt: number | null;
}) {
  if (Platform.OS === "web") return;
  await cancelDiaryReminders(respondentId);
  if (!plan?.active || !(plan.dueHours > 0)) return;
  if (!(await ensurePermission())) return;

  const now = Date.now();
  const end = plan.endDate ? Date.parse(`${plan.endDate}T23:59:59Z`) : Infinity;
  const series = (base: number, includeDue: boolean) => [
    ...(includeDue ? [{ at: base + plan.dueHours * HOUR, kind: "due" as const }] : []),
    ...Array.from({ length: MISSED_FOLLOW_UPS + 1 }, (_, i) => ({ at: base + (plan.missedHours + i * plan.dueHours) * HOUR, kind: "missed" as const })),
  ];
  let times = series(lastEntryAt ?? now, true).filter((t) => t.at > now);
  // Long overdue: every planned time has passed, so keep nudging from now.
  if (!times.length) times = series(now - plan.missedHours * HOUR + plan.dueHours * HOUR, false).filter((t) => t.at > now);
  times = times.filter((t) => t.at <= end);

  const hi = `Hi${name ? " " + name : ""}`;
  await Promise.all(times.map((t, i) => Notifications.scheduleNotificationAsync({
    identifier: `${PREFIX}${respondentId}-${i}`,
    content: {
      title: `${studyName} — diary reminder`,
      body: t.kind === "missed"
        ? `${hi}, you're overdue to log your consumption diary. Please add an entry when you can.`
        : `${hi}, it's time to log your consumption diary.`,
      data: { respondentId },
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(t.at), channelId: CHANNEL_ID },
  })));
}

// On-device diary reminders for app respondents. The server's reminder engine
// skips app users (lib/reminders.js); instead the app schedules local
// notifications from the study's due/missed thresholds (served on the home
// payload) counted from the respondent's latest entry. Every call cancels and
// re-plans, so opening the study or submitting an entry pushes reminders out.
// Local notifications need no Firebase or push server -- only the OS
// notification permission, which is requested automatically (Android 13+
// shows its one-time system prompt; older Android grants it by default).
//
// Habit timing: when the server marks a respondent's plan timing "habit", each
// reminder is moved to the time of day they usually log (from past entries),
// so it lands when they're likely free. The server keeps one respondent in five
// on "fixed" timing as a control (lib/reminders.js reminderTiming).
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

export type ReminderPlan = { dueHours: number; missedHours: number; active: boolean; endDate: string | null; timing?: "habit" | "fixed" };

const CHANNEL_ID = "diary-reminders";
const PREFIX = "diary-reminder-";
const HOUR = 36e5;
// Overdue nudges after the first "missed" one, spaced one due-interval apart.
const MISSED_FOLLOW_UPS = 4;
const DAY_MINUTES = 1440;
// A habit needs this many recent entries, enough of them within an hour of
// each other; scattered logging keeps the fixed schedule.
const HABIT_MIN_ENTRIES = 3;
const HABIT_RECENT = 20;
const HABIT_WINDOW = 60;
const HABIT_SHARE = 0.4;

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

function entryTimes(records: { status: string; entryTime?: string | null; submitTime?: string | null }[], queuedAt: string[]) {
  return [
    ...records.filter((r) => r.status === "submitted").map((r) => parseTime(r.submitTime || r.entryTime)),
    ...queuedAt.map(parseTime),
  ].filter(Number.isFinite);
}

const circularGap = (a: number, b: number) => { const d = Math.abs(a - b) % DAY_MINUTES; return Math.min(d, DAY_MINUTES - d); };

// The local minute of day this person usually logs, or null without a clear
// habit. Takes the busiest hour-either-side window over recent entries and
// averages it on the clock face, so 23:30 and 00:30 average to midnight.
export function habitMinute(times: number[]) {
  const minutes = [...times].sort((a, b) => b - a).slice(0, HABIT_RECENT)
    .map((t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); });
  if (minutes.length < HABIT_MIN_ENTRIES) return null;
  let best: number[] = [];
  for (const m of minutes) {
    const near = minutes.filter((x) => circularGap(x, m) <= HABIT_WINDOW);
    if (near.length > best.length) best = near;
  }
  if (best.length < Math.max(HABIT_MIN_ENTRIES, Math.ceil(minutes.length * HABIT_SHARE))) return null;
  const angle = (m: number) => (m / DAY_MINUTES) * 2 * Math.PI;
  const x = best.reduce((sum, m) => sum + Math.cos(angle(m)), 0), y = best.reduce((sum, m) => sum + Math.sin(angle(m)), 0);
  return Math.round(((Math.atan2(y, x) / (2 * Math.PI)) * DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES);
}

// Moves a reminder to the nearest occurrence of the habit minute (at most
// half a day either way), never into the past or sooner than half a cadence
// after the last entry. Returns null when no occurrence qualifies.
export function alignToHabit(at: number, minute: number, notBefore: number) {
  const candidates = [-1, 0, 1].map((offset) => {
    const d = new Date(at);
    d.setDate(d.getDate() + offset);
    d.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
    return d.getTime();
  }).filter((c) => c >= notBefore);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (Math.abs(b - at) < Math.abs(a - at) ? b : a));
}

export function latestEntryTime(records: { status: string; entryTime?: string | null; submitTime?: string | null }[], queuedAt: string[] = []) {
  const times = entryTimes(records, queuedAt);
  return times.length ? Math.max(...times) : null;
}

export function entryHistory(records: { status: string; entryTime?: string | null; submitTime?: string | null }[], queuedAt: string[] = []) {
  return entryTimes(records, queuedAt);
}

export function planReminderTimes(plan: ReminderPlan, lastEntryAt: number | null, history: number[], now = Date.now()) {
  const end = plan.endDate ? Date.parse(`${plan.endDate}T23:59:59Z`) : Infinity;
  const series = (base: number, includeDue: boolean) => [
    ...(includeDue ? [{ at: base + plan.dueHours * HOUR, kind: "due" as const }] : []),
    ...Array.from({ length: MISSED_FOLLOW_UPS + 1 }, (_, i) => ({ at: base + (plan.missedHours + i * plan.dueHours) * HOUR, kind: "missed" as const })),
  ];
  let times = series(lastEntryAt ?? now, true).filter((t) => t.at > now);
  // Long overdue: every planned time has passed, so keep nudging from now.
  if (!times.length) times = series(now - plan.missedHours * HOUR + plan.dueHours * HOUR, false).filter((t) => t.at > now);

  const minute = plan.timing === "habit" ? habitMinute(history) : null;
  if (minute != null) {
    const notBefore = Math.max(now + 60_000, (lastEntryAt ?? now) + (plan.dueHours * HOUR) / 2);
    let previous = -Infinity;
    times = times.flatMap((t) => {
      const at = alignToHabit(t.at, minute, Math.max(notBefore, previous + HOUR));
      if (at == null) return [];
      previous = at;
      return [{ ...t, at }];
    });
  }
  return { times: times.filter((t) => t.at <= end), timing: minute != null ? "habit" as const : "fixed" as const };
}

export async function scheduleDiaryReminders({ respondentId, studyName, name, plan, lastEntryAt, history = [] }: {
  respondentId: number; studyName: string; name?: string | null; plan?: ReminderPlan | null; lastEntryAt: number | null; history?: number[];
}) {
  if (Platform.OS === "web") return;
  await cancelDiaryReminders(respondentId);
  if (!plan?.active || !(plan.dueHours > 0)) return;
  if (!(await ensurePermission())) return;

  const { times, timing } = planReminderTimes(plan, lastEntryAt, history);

  const hi = `Hi${name ? " " + name : ""}`;
  await Promise.all(times.map((t, i) => Notifications.scheduleNotificationAsync({
    identifier: `${PREFIX}${respondentId}-${i}`,
    content: {
      title: `${studyName} — diary reminder`,
      body: t.kind === "missed"
        ? `${hi}, you're overdue to log your consumption diary. Please add an entry when you can.`
        : `${hi}, it's time to log your consumption diary.`,
      data: { respondentId, timing },
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(t.at), channelId: CHANNEL_ID },
  })));
}

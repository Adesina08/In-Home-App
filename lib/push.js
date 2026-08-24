// Web Push wrapper (respondent diary reminders). Uses the standard W3C Push API
// + VAPID -- the same mechanism behind "Allow notifications?" prompts on any
// website, delivered via the browser's own push service (Chrome/Edge -> Google's
// FCM endpoint, Firefox -> Mozilla's, Safari -> Apple's). No app-store account,
// Firebase project, or APNs certificate is needed for this to work in a browser
// or an installed/home-screen PWA. It does NOT reach the Capacitor-wrapped native
// shells in mobile/ -- those would need @capacitor/push-notifications wired to
// real FCM/APNs credentials, which requires accounts only the study owner can
// create (see mobile/README.md).
//
// Leave VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY unset to keep this feature
// harmlessly disabled (isEnabled() false, sendToRespondent() a no-op) -- same
// "mock until configured" pattern as brand detection / transcription.
const webpush = require("web-push");
const db = require("./db");

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@inicio.app";

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  if (!PUBLIC_KEY || !PRIVATE_KEY) return false;
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
  configured = true;
  return true;
}

function isEnabled() {
  return !!(PUBLIC_KEY && PRIVATE_KEY);
}

function getPublicKey() {
  return PUBLIC_KEY;
}

// Upsert on endpoint: the same device re-subscribing (browser refreshed the
// subscription, or the respondent re-opened the diary) replaces its old row
// instead of accumulating duplicates.
function saveSubscription(respondentId, subscription, userAgent) {
  if (!subscription || !subscription.endpoint || !subscription.keys) return false;
  db.prepare(
    `INSERT INTO push_subscriptions (respondent_id, endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       respondent_id = excluded.respondent_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent`
  ).run(respondentId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent || null);
  return true;
}

function removeSubscription(respondentId, endpoint) {
  db.prepare("DELETE FROM push_subscriptions WHERE respondent_id = ? AND endpoint = ?").run(respondentId, endpoint);
}

function getSubscriptionsForRespondent(respondentId) {
  return db.prepare("SELECT * FROM push_subscriptions WHERE respondent_id = ?").all(respondentId);
}

function hasSubscription(respondentId) {
  const row = db.prepare("SELECT COUNT(*) c FROM push_subscriptions WHERE respondent_id = ?").get(respondentId);
  return row.c > 0;
}

// Sends to every device this respondent has subscribed on (e.g. phone + a
// browser tab). A subscription the push service reports as gone (410) or not
// found (404) is pruned so the table doesn't accumulate dead endpoints.
async function sendToRespondent(respondentId, payload) {
  if (!ensureConfigured()) return { sent: 0, total: 0, reason: "not-configured" };
  const subs = getSubscriptionsForRespondent(respondentId);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        removeSubscription(respondentId, s.endpoint);
      } else {
        console.error(`Push send failed for respondent ${respondentId}:`, e.message);
      }
    }
  }
  return { sent, total: subs.length };
}

module.exports = {
  isEnabled,
  getPublicKey,
  saveSubscription,
  removeSubscription,
  getSubscriptionsForRespondent,
  hasSubscription,
  sendToRespondent,
};

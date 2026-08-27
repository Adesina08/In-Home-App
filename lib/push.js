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
const store = require("./store");

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
async function saveSubscription(respondentId, subscription, userAgent) {
  if (!subscription || !subscription.endpoint || !subscription.keys) return false;
  // ON CONFLICT(endpoint) DO UPDATE, done as look-up-then-write: endpoint is the
  // unique key, so an existing row for this device is updated in place and
  // keeps its id and created_at, exactly as the upsert did.
  const existing = await store.findOne("push_subscriptions", { endpoint: subscription.endpoint });
  const fields = {
    respondent_id: respondentId,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    user_agent: userAgent || null,
  };
  if (existing) {
    await store.update("push_subscriptions", { id: existing.id }, fields);
  } else {
    await store.insert("push_subscriptions", { endpoint: subscription.endpoint, ...fields });
  }
  return true;
}

async function removeSubscription(respondentId, endpoint) {
  await store.remove("push_subscriptions", { respondent_id: respondentId, endpoint });
}

async function getSubscriptionsForRespondent(respondentId) {
  return store.find("push_subscriptions", { respondent_id: respondentId });
}

async function hasSubscription(respondentId) {
  return (await store.count("push_subscriptions", { respondent_id: respondentId })) > 0;
}

// Sends to every device this respondent has subscribed on (e.g. phone + a
// browser tab). A subscription the push service reports as gone (410) or not
// found (404) is pruned so the table doesn't accumulate dead endpoints.
async function sendToRespondent(respondentId, payload) {
  if (!ensureConfigured()) return { sent: 0, total: 0, reason: "not-configured" };
  const subs = await getSubscriptionsForRespondent(respondentId);
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
        await removeSubscription(respondentId, s.endpoint);
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

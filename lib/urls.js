// Builds an absolute, shareable URL for a respondent's personal diary link.
// Relies on Express's req.protocol, which only reports "https" correctly
// behind Azure's proxy once NODE_ENV=production has `app.set("trust proxy", 1)`
// switched on (see server.js) -- otherwise every link would render as
// http://, which browsers block from installing as a PWA.
function respondentDiaryUrl(req, token) {
  return `${req.protocol}://${req.get("host")}/r/${token}`;
}

// Same trust-proxy caveat as above -- the general, non-personalized app URL
// used by the public "Get the App" page (scan-to-open / install shortcut).
function appBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

// The base URL to use when there is no request to derive it from -- the
// background reminder engine (lib/scheduler.js) runs on a timer, not a click,
// so it has no req and cannot guess the public hostname.
//
// Returns null rather than a fabricated localhost URL when APP_BASE_URL isn't
// set: a reminder SMS containing "http://localhost:3000/r/..." is worse than
// one with no link at all, so callers leave the link out instead.
function configuredBaseUrl() {
  const raw = (process.env.APP_BASE_URL || "").trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/** A respondent's diary link for a background job, or null if unknowable. */
function respondentDiaryUrlFromConfig(token) {
  const base = configuredBaseUrl();
  return base ? `${base}/r/${token}` : null;
}

module.exports = { respondentDiaryUrl, appBaseUrl, configuredBaseUrl, respondentDiaryUrlFromConfig };

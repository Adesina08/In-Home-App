// Builds absolute respondent URLs. Invitation links deliberately enter the
// onboarding state machine; diary links are for respondents who are already
// enrolled and are returning to complete an entry.
function respondentInviteUrl(req, token) {
  return `${req.protocol}://${req.get("host")}/invite/${token}`;
}

function respondentDiaryUrl(req, token) {
  return `${req.protocol}://${req.get("host")}/r/${token}`;
}

function appBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function configuredBaseUrl() {
  const raw = (process.env.APP_BASE_URL || "").trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

function respondentInviteUrlFromConfig(token) {
  const base = configuredBaseUrl();
  return base ? `${base}/invite/${token}` : null;
}

function respondentDiaryUrlFromConfig(token) {
  const base = configuredBaseUrl();
  return base ? `${base}/r/${token}` : null;
}

module.exports = {
  respondentInviteUrl,
  respondentDiaryUrl,
  appBaseUrl,
  configuredBaseUrl,
  respondentInviteUrlFromConfig,
  respondentDiaryUrlFromConfig,
};

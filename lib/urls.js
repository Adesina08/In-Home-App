// Builds an absolute, shareable URL for a respondent's personal diary link.
// Relies on Express's req.protocol, which only reports "https" correctly
// behind Azure's proxy once NODE_ENV=production has `app.set("trust proxy", 1)`
// switched on (see server.js) -- otherwise every link would render as
// http://, which browsers block from installing as a PWA.
function respondentDiaryUrl(req, token) {
  return `${req.protocol}://${req.get("host")}/r/${token}`;
}

module.exports = { respondentDiaryUrl };

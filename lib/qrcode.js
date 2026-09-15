// Generates QR codes entirely server-side (the `qrcode` npm package renders
// the image itself -- no call to any third-party QR API), so this works
// offline and never depends on an external service being reachable.
const QRCode = require("qrcode");

const STYLE = {
  margin: 1,
  color: { dark: "#0f172a", light: "#ffffff" },
};

// Returns a data: URL (PNG) suitable for a plain <img src="..."> -- used on
// the interviewer's "Respondent Activated" screen, generated once at
// registration time so nothing extra needs to be fetched.
function qrDataUrl(text, size = 320) {
  return QRCode.toDataURL(text, { ...STYLE, width: size });
}

// Streams a QR PNG directly to an Express response -- used for the
// on-demand "QR" button in the admin Respondents table, so a study with
// many respondents never has to generate every respondent's code up front.
function qrPngToResponse(res, text, size = 320) {
  res.set("Content-Type", "image/png");
  return QRCode.toFileStream(res, text, { ...STYLE, width: size });
}

// Raw PNG bytes -- used to attach a QR code as an inline (cid:) image in an
// email. A data: URL (qrDataUrl) can't be used there: Gmail, Outlook and
// several other major clients strip or refuse to render data: URIs in
// <img src>, so the image would just show as broken for most recipients.
function qrPngBuffer(text, size = 320) {
  return QRCode.toBuffer(text, { ...STYLE, width: size });
}

module.exports = { qrDataUrl, qrPngToResponse, qrPngBuffer };

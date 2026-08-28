// Temporary pilot switch for respondent OTP verification.
//
// The Twilio setup is not complete yet, so respondent-facing OTP can be
// bypassed without deleting the verification implementation. Set
// RESPONDENT_OTP_BYPASS=false in Azure once Twilio is ready to restore the
// normal verification flow.
function isBypassed() {
  const raw = String(process.env.RESPONDENT_OTP_BYPASS || "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

module.exports = { isBypassed };

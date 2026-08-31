// The single definition of what a contact is.
//
// It is used BOTH where a contact is written and where one is looked up. That
// pairing is the whole point: storing one shape and searching for another
// produces no error anywhere, which is exactly how the previous bug hid. A
// respondent invited in bulk (stored "+234801...") who then typed "0801..."
// did not match their own account, and because the sign-in page must not
// reveal whether an account exists, that failure looked identical to a wrong
// code. They could never get in and nothing was logged.
//
// Twilio accepts E.164 and nothing else. Before this, only bulk invite wrote
// that shape -- face-to-face registration, self-signup and the single admin
// invite stored whatever was typed, so those three recruitment routes would
// have kept failing even after the Twilio settings were fixed, with nothing in
// the UI to explain why.

const DEFAULT_COUNTRY_CODE = (process.env.DEFAULT_COUNTRY_CODE || "+234").trim();

// Market name (from study.market) -> dialling code. Extend as studies expand;
// anything unlisted falls back to DEFAULT_COUNTRY_CODE.
const MARKET_DIAL_CODES = {
  nigeria: "+234", ng: "+234",
  ghana: "+233", gh: "+233",
  kenya: "+254", ke: "+254",
  "south africa": "+27", za: "+27",
  "united kingdom": "+44", uk: "+44", gb: "+44",
  "united states": "+1", us: "+1", usa: "+1",
};

function isEmail(value) {
  return String(value || "").includes("@");
}

function dialCodeForMarket(market) {
  const key = String(market || "").trim().toLowerCase();
  return MARKET_DIAL_CODES[key] || DEFAULT_COUNTRY_CODE;
}

/**
 * The stored form of a contact.
 *
 * Emails pass through lowercased and otherwise untouched -- some studies
 * collect one instead of a phone, and it is a legitimate contact even though
 * nothing can be texted to it.
 *
 * Phones become E.164. A number the function cannot confidently resolve is
 * returned stripped but unchanged rather than guessed at: writing a number
 * into a country nobody lives in is worse than leaving it alone, because the
 * damage is silent.
 */
function canonical(value, { market } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (isEmail(raw)) return raw.toLowerCase();

  const dial = dialCodeForMarket(market);
  const digits = raw.replace(/[^\d+]/g, "");

  // Already E.164.
  if (digits.startsWith("+")) return digits;
  // 00 international prefix.
  if (digits.startsWith("00")) return "+" + digits.slice(2);
  // Local trunk form: 0801... -> +234801...
  if (digits.startsWith("0")) return dial + digits.slice(1);
  // Country code without the plus: 234801... -> +234801...
  if (digits.startsWith(dial.slice(1))) return "+" + digits;
  // A bare subscriber number with no trunk zero.
  if (digits.length >= 7 && digits.length <= 12) return dial + digits;

  return digits;
}

/**
 * The loose key for a near-miss match: the last nine digits.
 *
 * This NEVER grants access on its own. The one-time code is sent to the number
 * stored on the account, so a near-miss reaches the real owner and nobody
 * else. Two accounts sharing those nine digits are treated as ambiguous and
 * neither is used.
 */
function looseKey(value) {
  if (isEmail(value)) return null;
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/** True when two contacts are the same identity. */
function sameContact(a, b, opts) {
  const ca = canonical(a, opts);
  const cb = canonical(b, opts);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const la = looseKey(ca);
  const lb = looseKey(cb);
  return !!la && la === lb;
}

/** Human-facing form: "+234 801 234 5678". Display only, never stored. */
function pretty(value) {
  if (isEmail(value)) return String(value || "");
  const c = canonical(value);
  if (!c.startsWith("+")) return c;
  const digits = c.slice(1);
  const cc = digits.slice(0, 3);
  const rest = digits.slice(3);
  return "+" + cc + " " + rest.replace(/(\d{3})(?=\d)/g, "$1 ").trim();
}

module.exports = {
  canonical, looseKey, sameContact, isEmail, pretty,
  dialCodeForMarket, DEFAULT_COUNTRY_CODE,
};

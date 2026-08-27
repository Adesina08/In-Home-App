// One-time passcodes for remote self-onboarding contact verification
// (spec Flow B step 3: "Verify -- Phone/email/OTP").
//
// Why this is stricter than it might look for a pilot: this is the one place
// where a stranger on the internet can create a respondent record and start
// contributing data to a client's dataset. Contact verification is what stops
// one person registering fifty times with made-up numbers, so the checks below
// (hashed codes, expiry, attempt cap, resend cooldown) are what make the
// remote path trustworthy rather than decorative.
//
// DELIVERY IS MOCKED. There is no SMS/email provider wired up -- codes are
// written to the WhatsApp outbox so staff can read them from Admin > WhatsApp
// during the pilot, exactly like the reminder engine's messages. See
// PRODUCTION_READINESS.md B1: point OTP_DELIVERY at a real provider before
// running an unsupervised public recruitment link.

const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const store = require("./store");
const { getProvider: getWhatsAppProvider } = require("./whatsapp");

const CODE_LENGTH = 6;
const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

/** Cryptographically random 6-digit code (Math.random is not acceptable here). */
function generateCode() {
  const max = 10 ** CODE_LENGTH;
  // Rejection-sample so every code is equally likely -- a plain modulo would
  // very slightly favour lower codes.
  let n;
  do {
    n = crypto.randomBytes(4).readUInt32BE(0);
  } while (n >= Math.floor(4294967296 / max) * max);
  return String(n % max).padStart(CODE_LENGTH, "0");
}

/** Normalized contact, so "+234 801..." and "0801..." aren't treated as different. */
function normalizeContact(contact) {
  return String(contact || "").replace(/[\s\-()]/g, "").toLowerCase();
}

async function latestActiveCode(contact, purpose = "contact_verification") {
  // ORDER BY datetime(created_at) becomes a plain sort on the string: stored
  // times are fixed-width UTC 'YYYY-MM-DD HH:MM:SS', so they sort lexically.
  return store.findOne(
    "otp_codes",
    { contact: normalizeContact(contact), purpose, consumed_at: null },
    { sort: { created_at: -1 } }
  );
}

/**
 * Seconds the caller must wait before another code may be sent, or 0 if a
 * send is allowed right now. Prevents using the send endpoint to spam someone
 * else's phone.
 */
async function resendCooldownRemaining(contact, purpose = "contact_verification") {
  const row = await store.findOne(
    "otp_codes",
    { contact: normalizeContact(contact), purpose },
    { sort: { created_at: -1 }, projection: { created_at: 1 } }
  );
  if (!row) return 0;
  const elapsed = (Date.now() - new Date(row.created_at + "Z").getTime()) / 1000;
  const remaining = Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed);
  return remaining > 0 ? remaining : 0;
}

/**
 * Issue and "send" a code. Any earlier unconsumed code for the same contact is
 * consumed first, so exactly one code is ever live -- otherwise a respondent
 * who hit Resend twice could be confused about which code works, and the
 * attempt cap would be trivially bypassable by rotating between codes.
 */
async function sendCode({ contact, respondentId, purpose = "contact_verification", studyName }) {
  const normalized = normalizeContact(contact);
  if (!normalized) throw new Error("A contact is required to send a verification code.");

  const wait = await resendCooldownRemaining(normalized, purpose);
  if (wait > 0) {
    const err = new Error(`Please wait ${wait} more second${wait === 1 ? "" : "s"} before requesting another code.`);
    err.code = "COOLDOWN";
    err.retryAfter = wait;
    throw err;
  }

  await store.update(
    "otp_codes",
    { contact: normalized, purpose, consumed_at: null },
    { consumed_at: store.nowSql() }
  );

  const code = generateCode();
  const codeHash = bcrypt.hashSync(code, 10);
  const inserted = await store.insert("otp_codes", {
    respondent_id: respondentId || null,
    contact: normalized,
    code_hash: codeHash,
    purpose,
    // datetime('now', '+N minutes') -- nowSql takes the offset in milliseconds.
    expires_at: store.nowSql(TTL_MINUTES * 60 * 1000),
  });

  const result = await getWhatsAppProvider().send({
    respondentId: respondentId || null,
    to: contact,
    template: "otp_contact_verification",
    variables: { code, study: studyName || "", expires_in_minutes: TTL_MINUTES },
  });

  // The provider REPORTS failure, it doesn't throw. Before this check, a
  // rejected message (bad sender, region not enabled, unverified trial
  // recipient) sailed through and the screen said "a new code is on its way"
  // to someone who would never receive one -- they'd sit waiting, retry, and
  // conclude the app was broken, with the real reason sitting in the Message
  // Log where nobody thought to look.
  if (!result || !result.ok) {
    // Drop the code we just issued. Leaving it would start the 60-second
    // resend cooldown on a code that was never delivered, so a person who
    // fixes the problem and immediately retries would be told to wait.
    await store.remove("otp_codes", { id: inserted.id });
    const err = new Error(
      (result && result.error) || "The verification code could not be sent."
    );
    err.code = "DELIVERY";
    throw err;
  }

  // A simulated send is not a send. Reported so callers can say plainly that
  // nothing was delivered rather than asking someone to check a phone that
  // will never ring.
  return { sent: true, simulated: !!result.simulated, expiresInMinutes: TTL_MINUTES };
}

/**
 * Check a submitted code. Returns { ok: true } or { ok: false, reason }.
 * Never reveals whether a wrong code was close, and always burns an attempt.
 */
async function verifyCode({ contact, code, purpose = "contact_verification" }) {
  const normalized = normalizeContact(contact);
  const row = await latestActiveCode(normalized, purpose);
  if (!row) return { ok: false, reason: "No verification code is waiting for this contact. Request a new one." };

  if (new Date(row.expires_at + "Z").getTime() < Date.now()) {
    await store.update("otp_codes", { id: row.id }, { consumed_at: store.nowSql() });
    return { ok: false, reason: "That code has expired. Request a new one." };
  }

  if (row.attempts >= MAX_ATTEMPTS) {
    await store.update("otp_codes", { id: row.id }, { consumed_at: store.nowSql() });
    return { ok: false, reason: "Too many incorrect attempts. Request a new code." };
  }

  // Count the attempt before comparing, so a crash mid-compare can't hand out
  // a free guess.
  // attempts = attempts + 1 is computed from the row just read, since the
  // store's update takes values rather than expressions.
  await store.update("otp_codes", { id: row.id }, { attempts: row.attempts + 1 });

  const submitted = String(code || "").trim();
  if (!submitted || !bcrypt.compareSync(submitted, row.code_hash)) {
    const left = MAX_ATTEMPTS - (row.attempts + 1);
    return {
      ok: false,
      reason: left > 0 ? `That code isn't right. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many incorrect attempts. Request a new code.",
    };
  }

  await store.update("otp_codes", { id: row.id }, { consumed_at: store.nowSql() });
  return { ok: true };
}

module.exports = {
  sendCode,
  verifyCode,
  normalizeContact,
  resendCooldownRemaining,
  TTL_MINUTES,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
};

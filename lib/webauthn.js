// Wires the respondent's device fingerprint/Face ID/PIN lock using WebAuthn's
// "platform authenticator" -- the same mechanism a phone uses to unlock a password
// manager or banking app. This never replaces a respondent's actual identity (that's
// still their unique diary link/token); it's a device-level lock in front of it, so
// someone who picks up an unlocked phone can't just open the diary link and see it.
//
// Registration ("set up the lock") happens once per device. Every later visit
// requires a fresh authentication ("unlock") -- see the requireBiometricLock
// middleware in routes/respondent.js for how this is enforced.
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const { isoUint8Array, isoBase64URL } = require("@simplewebauthn/server/helpers");
const db = require("./db");

const RP_NAME = "INICIO";

// The RP ID must be the site's bare hostname (no scheme/port), and the expected
// origin must be the full origin -- both are derived from the request rather than
// hardcoded, so this keeps working if the app moves to a different Azure hostname
// or a custom domain later without any code change.
function rpIdFor(req) {
  return req.hostname;
}
function originFor(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function getCredentialsForRespondent(respondentId) {
  return db.prepare("SELECT * FROM respondent_credentials WHERE respondent_id = ?").all(respondentId);
}

async function buildRegistrationOptions(req, respondent) {
  const existing = getCredentialsForRespondent(respondent.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpIdFor(req),
    userName: respondent.respondent_code || `respondent-${respondent.id}`,
    userID: isoUint8Array.fromUTF8String(String(respondent.id)),
    userDisplayName: respondent.respondent_code || "Respondent",
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credential_id })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required", // require the actual fingerprint/face/PIN check, not just "a key is present"
      authenticatorAttachment: "platform", // the device's own built-in authenticator, not a USB security key
    },
  });
  req.session.currentChallenge = options.challenge;
  return options;
}

async function verifyRegistration(req, respondent, responseJSON) {
  const expectedChallenge = req.session.currentChallenge;
  if (!expectedChallenge) throw new Error("No registration in progress for this session.");
  const verification = await verifyRegistrationResponse({
    response: responseJSON,
    expectedChallenge,
    expectedOrigin: originFor(req),
    expectedRPID: rpIdFor(req),
  });
  delete req.session.currentChallenge;
  if (!verification.verified || !verification.registrationInfo) return false;

  const { credential } = verification.registrationInfo;
  db.prepare(
    "INSERT INTO respondent_credentials (respondent_id, credential_id, public_key, counter, device_label) VALUES (?, ?, ?, ?, ?)"
  ).run(
    respondent.id,
    credential.id,
    isoBase64URL.fromBuffer(credential.publicKey),
    credential.counter,
    (req.get("user-agent") || "").slice(0, 120)
  );
  return true;
}

async function buildAuthenticationOptions(req, respondent) {
  const existing = getCredentialsForRespondent(respondent.id);
  const options = await generateAuthenticationOptions({
    rpID: rpIdFor(req),
    allowCredentials: existing.map((c) => ({ id: c.credential_id })),
    userVerification: "required",
  });
  req.session.currentChallenge = options.challenge;
  return options;
}

async function verifyAuthentication(req, respondent, responseJSON) {
  const expectedChallenge = req.session.currentChallenge;
  if (!expectedChallenge) throw new Error("No unlock attempt in progress for this session.");
  const stored = db
    .prepare("SELECT * FROM respondent_credentials WHERE respondent_id = ? AND credential_id = ?")
    .get(respondent.id, responseJSON.id);
  if (!stored) return false;

  const verification = await verifyAuthenticationResponse({
    response: responseJSON,
    expectedChallenge,
    expectedOrigin: originFor(req),
    expectedRPID: rpIdFor(req),
    credential: {
      id: stored.credential_id,
      publicKey: isoBase64URL.toBuffer(stored.public_key),
      counter: stored.counter,
    },
    requireUserVerification: true,
  });
  delete req.session.currentChallenge;
  if (!verification.verified) return false;

  db.prepare("UPDATE respondent_credentials SET counter = ? WHERE id = ?").run(
    verification.authenticationInfo.newCounter,
    stored.id
  );
  return true;
}

module.exports = {
  getCredentialsForRespondent,
  buildRegistrationOptions,
  verifyRegistration,
  buildAuthenticationOptions,
  verifyAuthentication,
};

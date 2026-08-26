// Public study code behind the remote self-onboarding invite link
// (spec Flow B step 1: "Invite -- Unique link / study code").
//
// Deliberately NOT the numeric study id: the invite link is handed out
// publicly (posters, social, a message forwarded on), and a sequential id
// would let anyone enumerate every study on the platform by counting upwards.
// A random code means knowing one study's link tells you nothing about any
// other. It is not a secret though -- it only opens the public sign-up flow,
// never any collected data.
const crypto = require("crypto");
const db = require("./db");

// No vowels (can't accidentally spell anything), and no 0/O/1/I/L, which are
// the characters people misread when copying a code off a poster by hand.
const ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 8;

function generateCode() {
  let out = "";
  const bytes = crypto.randomBytes(CODE_LENGTH);
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** The study's join code, generated on first use. */
function getOrCreateJoinCode(studyId) {
  const study = db.prepare("SELECT id, join_code FROM studies WHERE id = ?").get(studyId);
  if (!study) return null;
  if (study.join_code) return study.join_code;

  // Retry on the (vanishingly unlikely) chance of a collision rather than
  // handing two studies the same public link.
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode();
    const taken = db.prepare("SELECT 1 FROM studies WHERE join_code = ?").get(code);
    if (taken) continue;
    db.prepare("UPDATE studies SET join_code = ? WHERE id = ?").run(code, studyId);
    return code;
  }
  throw new Error("Could not allocate a unique join code for this study.");
}

function findStudyByJoinCode(code) {
  if (!code) return null;
  return db.prepare("SELECT * FROM studies WHERE join_code = ?").get(String(code).trim().toUpperCase());
}

/** Whether this study currently accepts remote self-onboarding. */
function remoteOnboardingOpen(study) {
  if (!study) return false;
  if (study.status !== "live") return false; // draft studies aren't recruiting; closed ones are done
  return study.recruitment_mode === "remote" || study.recruitment_mode === "hybrid";
}

module.exports = { getOrCreateJoinCode, findStudyByJoinCode, remoteOnboardingOpen };

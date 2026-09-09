const crypto = require("crypto");
const store = require("./store");

const TOKEN_TTL_DAYS = Math.max(1, parseInt(process.env.MOBILE_TOKEN_TTL_DAYS || "30", 10));
const RESET_TICKET_TTL_MINUTES = 10;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

async function issueSession({ accountId = null, respondentId = null, userId = null }) {
  if (!accountId && !respondentId && !userId) throw new Error("A mobile session needs an account, respondent, or staff user.");
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = store.nowSql(TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await store.insert("mobile_sessions", {
    token_hash: hashToken(token),
    account_id: accountId || null,
    respondent_id: respondentId || null,
    user_id: userId || null,
    created_at: store.nowSql(),
    last_seen_at: store.nowSql(),
    expires_at: expiresAt,
  });
  return { token, expiresAt };
}

async function authenticateRequest(req) {
  const header = String(req.get("authorization") || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const token = match[1].trim();
  if (!token) return null;

  const session = await store.findOne("mobile_sessions", { token_hash: hashToken(token) });
  if (!session) return null;
  if (session.expires_at && session.expires_at <= store.nowSql()) {
    await store.remove("mobile_sessions", { id: session.id });
    return null;
  }

  await store.update("mobile_sessions", { id: session.id }, { last_seen_at: store.nowSql() });
  const account = session.account_id ? await store.findOne("respondent_accounts", { id: session.account_id }) : null;
  const respondent = session.respondent_id ? await store.findOne("respondents", { id: session.respondent_id }) : null;
  const user = session.user_id ? await store.findOne("users", { id: session.user_id }) : null;
  if (!account && !respondent && !user) return null;
  return { token, session, account, respondent, user };
}

async function revokeToken(token) {
  if (!token) return;
  await store.remove("mobile_sessions", { token_hash: hashToken(token) });
}

/**
 * Proof that a contact's password-reset code was just verified, redeemable
 * once for setting a new password. Kept separate from mobile_sessions (which
 * grants API access) since verifying a code should not yet sign anyone in --
 * only completing the reset does.
 */
async function issuePasswordResetTicket(accountId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = store.nowSql(RESET_TICKET_TTL_MINUTES * 60 * 1000);
  await store.insert("password_reset_tickets", {
    token_hash: hashToken(token),
    account_id: accountId,
    expires_at: expiresAt,
  });
  return { token, expiresAt };
}

/** Redeems a reset ticket exactly once, returning the account id or null. */
async function consumePasswordResetTicket(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const ticket = await store.findOne("password_reset_tickets", { token_hash: hashToken(raw), consumed_at: null });
  if (!ticket) return null;
  if (ticket.expires_at && ticket.expires_at <= store.nowSql()) return null;
  await store.update("password_reset_tickets", { id: ticket.id }, { consumed_at: store.nowSql() });
  return ticket.account_id;
}

module.exports = {
  TOKEN_TTL_DAYS,
  issueSession,
  authenticateRequest,
  revokeToken,
  issuePasswordResetTicket,
  consumePasswordResetTicket,
};

const crypto = require("crypto");
const store = require("./store");

const TOKEN_TTL_DAYS = Math.max(1, parseInt(process.env.MOBILE_TOKEN_TTL_DAYS || "30", 10));

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

async function issueSession({ accountId = null, respondentId = null }) {
  if (!accountId && !respondentId) throw new Error("A mobile session needs an account or respondent.");
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = store.nowSql(TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await store.insert("mobile_sessions", {
    token_hash: hashToken(token),
    account_id: accountId || null,
    respondent_id: respondentId || null,
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
  if (!account && !respondent) return null;
  return { token, session, account, respondent };
}

async function revokeToken(token) {
  if (!token) return;
  await store.remove("mobile_sessions", { token_hash: hashToken(token) });
}

module.exports = { TOKEN_TTL_DAYS, issueSession, authenticateRequest, revokeToken };

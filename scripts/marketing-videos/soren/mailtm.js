// Throwaway inboxes on the public mail.tm API, used only for the fictional respondents'
// email verification codes. Inbox credentials are kept in .work/soren/inboxes.json so a
// respondent can sign in again later with the same address.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIR } = require('./common');

const API = 'https://api.mail.tm';
const STORE = path.join(DIR, 'inboxes.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body, token) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 8) { await sleep(2000 * (attempt + 1)); continue; } // rate limited
    if (!res.ok) throw new Error(`mail.tm ${method} ${url}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
}

const load = () => (fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : {});

/** The inbox for a respondent key, created on first use. */
async function inbox(key) {
  const all = load();
  if (!all[key]) {
    const { 'hydra:member': domains } = await call('GET', '/domains');
    const local = `${key.toLowerCase().replace(/[^a-z0-9]/g, '')}${crypto.randomBytes(3).toString('hex')}`;
    const address = `${local}@${domains[0].domain}`, password = crypto.randomBytes(12).toString('hex');
    await call('POST', '/accounts', { address, password });
    all[key] = { address, password };
    fs.writeFileSync(STORE, JSON.stringify(all, null, 2));
  }
  const { token } = await call('POST', '/token', all[key]);
  return { ...all[key], token };
}

/** Wait for a message newer than `since` and return the first 4–8 digit code in it. */
async function waitForCode(box, { since = 0, timeout = 120000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const { 'hydra:member': msgs } = await call('GET', '/messages', null, box.token);
    const fresh = msgs.filter((m) => new Date(m.createdAt).getTime() >= since - 5000);
    if (fresh.length) {
      const msg = await call('GET', `/messages/${fresh[0].id}`, null, box.token);
      const text = `${msg.subject}\n${msg.text || ''}\n${(msg.html || []).join('\n').replace(/<[^>]+>/g, ' ')}`;
      const m = text.match(/\b(\d{4,8})\b/);
      if (m) return m[1];
    }
    await sleep(3000);
  }
  throw new Error(`No verification code reached ${box.address}`);
}

module.exports = { inbox, waitForCode };

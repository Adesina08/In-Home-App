const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
require("express-async-errors");

const store = require("../lib/store");
const accounts = require("../lib/respondentAccounts");

let dir;
let server;
let url;
let account;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "inicio-password-recovery-"));
  process.env.MESSAGING_PROVIDER = "mock";
  process.env.DEFAULT_COUNTRY_CODE = "+234";

  await store.connect({ uri: "", file: path.join(dir, "data.json") });
  account = await store.insert("respondent_accounts", {
    name: "Recovery Test",
    contact: "+2348012345678",
  });
  await accounts.setCredentials(account.id, {
    username: "recovery.user",
    password: "old-password-123",
  });

  const app = express();
  app.use(express.json());
  app.use("/mobile/api", require("../routes/mobilePasswordRecovery"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function post(route, body) {
  return fetch(url + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("password reset code is delivered to the registered contact, not a loose-match number", async () => {
  // These two E.164 numbers intentionally share the same last nine digits.
  // The loose account lookup may use the supplied number as a hint, but the
  // reset code must still go to the contact stored on the account.
  const supplied = "+447012345678";
  const response = await post("/mobile/api/auth/request-code", { contact: supplied });
  assert.equal(response.status, 200, await response.clone().text());

  const outbox = await store.findOne("whatsapp_outbox", {}, { sort: { id: -1 } });
  assert.ok(outbox);
  const payload = JSON.parse(outbox.payload_json);
  assert.equal(payload.to, "+2348012345678");
  assert.notEqual(payload.to, supplied);

  const activeCode = await store.findOne("otp_codes", {
    contact: "+2348012345678",
    purpose: "account_password_reset",
    consumed_at: null,
  });
  assert.ok(activeCode);

  const code = String(payload.body || "").match(/\b\d{6}\b/)?.[0];
  assert.ok(code, "mock outbox should contain the generated six-digit code");

  const verify = await post("/mobile/api/auth/verify", { contact: supplied, code });
  assert.equal(verify.status, 200, await verify.clone().text());
  const { resetToken } = await verify.json();
  assert.ok(resetToken);

  const reset = await post("/mobile/api/auth/reset-password", {
    resetToken,
    password: "new-password-456",
  });
  assert.equal(reset.status, 200, await reset.clone().text());
  const resetPayload = await reset.json();
  assert.ok(resetPayload.token, "successful reset should return the mobile session expected by the app");

  assert.equal(await accounts.verifyCredentials("recovery.user", "old-password-123"), null);
  assert.equal((await accounts.verifyCredentials("recovery.user", "new-password-456")).id, account.id);

  const replay = await post("/mobile/api/auth/reset-password", {
    resetToken,
    password: "another-password-789",
  });
  assert.equal(replay.status, 400, "a reset ticket must only be usable once");
});

test("request-code does not reveal whether a respondent account exists", async () => {
  const beforeOutbox = await store.count("whatsapp_outbox", {});
  const response = await post("/mobile/api/auth/request-code", { contact: "+2348099999999" });
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.simulated, "boolean");
  assert.equal(await store.count("whatsapp_outbox", {}), beforeOutbox);
});

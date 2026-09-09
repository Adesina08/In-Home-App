const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
require("express-async-errors");

const store = require("../lib/store");

let directory;
let server;
let base;
let respondent;
let previousWhatsappNumber;

before(async () => {
  previousWhatsappNumber = process.env.WHATSAPP_BOT_NUMBER;
  process.env.WHATSAPP_BOT_NUMBER = "+15551234567";

  directory = await fs.mkdtemp(path.join(os.tmpdir(), "inicio-invite-reentry-"));
  await store.connect({ uri: "", file: path.join(directory, "data.json") });

  const study = await store.insert("studies", {
    name: "Returning respondent study",
    status: "live",
    diary_mode: "daily",
    recruitment_mode: "remote",
  });
  const account = await store.insert("respondent_accounts", {
    name: "Returning Respondent",
    contact: "+2348012345678",
    username: "returning.user",
    password_hash: "already-has-credentials",
  });
  respondent = await store.insert("respondents", {
    study_id: study.id,
    account_id: account.id,
    name: "Returning Respondent",
    contact: "+2348012345678",
    respondent_code: "RETURN-1",
    unique_token: "returning-token",
    presurvey_completed_at: store.nowSql(),
    chosen_mode: "whatsapp",
    preferred_channel: "whatsapp",
    activation_status: "activated",
  });

  const app = express();
  app.set("views", path.join(__dirname, "../views"));
  app.set("view engine", "ejs");
  app.locals.icon = require("../lib/icons").icon;
  app.use(express.urlencoded({ extended: true }));
  app.use("/invite", require("../routes/inviteAppHandoff"));

  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (previousWhatsappNumber === undefined) delete process.env.WHATSAPP_BOT_NUMBER;
  else process.env.WHATSAPP_BOT_NUMBER = previousWhatsappNumber;

  await new Promise((resolve) => server.close(resolve));
  await store.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test("rescanning a WhatsApp invite lets an existing respondent switch to the Mobile App and download the APK", async () => {
  const rescan = await fetch(`${base}/invite/${respondent.unique_token}`, { redirect: "manual" });
  assert.equal(rescan.status, 200);
  const rescanHtml = await rescan.text();
  assert.match(rescanHtml, /Welcome back/);
  assert.match(rescanHtml, /Use the INICIO Diary Mobile App/);
  assert.match(rescanHtml, /Use WhatsApp/);
  assert.match(rescanHtml, /login is already set up/);

  const chooseApp = await fetch(`${base}/invite/${respondent.unique_token}/choose`, {
    method: "POST",
    body: new URLSearchParams({ mode: "app" }),
    redirect: "manual",
  });
  assert.equal(chooseApp.status, 302);
  assert.equal(chooseApp.headers.get("location"), `/invite/${respondent.unique_token}/ready`);

  let updated = await store.findOne("respondents", { id: respondent.id });
  assert.equal(updated.chosen_mode, "app");
  assert.equal(updated.preferred_channel, "app");

  const ready = await fetch(`${base}/invite/${respondent.unique_token}/ready`, { redirect: "manual" });
  assert.equal(ready.status, 200);
  const readyHtml = await ready.text();
  assert.match(readyHtml, /Download INICIO Diary/);
  assert.match(readyHtml, /\/public\/downloads\/inicio-diary\.apk/);
  assert.match(readyHtml, /Already installed\? Open INICIO Diary/);

  const chooseWhatsapp = await fetch(`${base}/invite/${respondent.unique_token}/choose`, {
    method: "POST",
    body: new URLSearchParams({ mode: "whatsapp" }),
    redirect: "manual",
  });
  assert.equal(chooseWhatsapp.status, 302);
  assert.equal(
    chooseWhatsapp.headers.get("location"),
    "https://wa.me/15551234567?text=JOIN%20returning-token"
  );

  updated = await store.findOne("respondents", { id: respondent.id });
  assert.equal(updated.chosen_mode, "whatsapp");
  assert.equal(updated.preferred_channel, "whatsapp");
});

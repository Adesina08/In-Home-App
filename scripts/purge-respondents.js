// One-off operational script: permanently remove every respondent (and every
// dependent record -- diary data, media, incentives, QC flags, sessions, ...)
// from whichever database MONGODB_URI/LOCAL_DB_PATH currently points at.
//
// Reuses routes/superadmin.js's deleteRespondentCascade so this behaves
// exactly like the tested per-respondent admin delete, just run for every
// respondent. Before deleting anything it writes a full JSON backup of every
// respondent-linked collection to backups/, so the run can be inspected or
// manually restored from if needed. Media blobs (photos, videos) are deleted
// by the cascade itself and are NOT included in the backup -- only their
// database metadata (e.g. file_path) is.
require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const store = require("../lib/store");
const { deleteRespondentCascade } = require("../routes/superadmin");

// Every collection that can hold respondent-linked data (see lib/store/index.js
// INDEXES and routes/superadmin.js's deleteRespondentCascade).
const BACKUP_COLLECTIONS = [
  "respondents",
  "respondent_profiles",
  "respondent_accounts",
  "respondent_credentials",
  "respondent_profile_snapshots",
  "diary_records",
  "diary_submissions",
  "responses",
  "media",
  "staged_media",
  "qc_flags",
  "coded_verbatims",
  "reminders",
  "whatsapp_outbox",
  "whatsapp_sessions",
  "whatsapp_inbound_messages",
  "otp_codes",
  "push_subscriptions",
  "end_validations",
  "follow_up_log",
  "incentive_ledger",
  "backchecks",
  "privacy_requests",
  "mobile_sessions",
];

async function backup(backupDir) {
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `respondent-purge-${stamp}.json`);

  const dump = {};
  for (const collection of BACKUP_COLLECTIONS) {
    try {
      dump[collection] = await store.find(collection, {});
    } catch (e) {
      console.warn(`Backup: skipped ${collection} (${e.message})`);
      dump[collection] = [];
    }
  }

  await fs.writeFile(backupPath, JSON.stringify(dump, null, 2));
  return { backupPath, counts: Object.fromEntries(Object.entries(dump).map(([k, v]) => [k, v.length])) };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await store.connect();

  const respondents = await store.find("respondents", {}, { projection: { id: 1, study_id: 1, respondent_code: 1 } });
  console.log(`Found ${respondents.length} respondent(s).`);

  if (!respondents.length) {
    console.log("Nothing to purge.");
    await store.close();
    return;
  }

  const backupDir = path.join(__dirname, "..", "backups");
  const { backupPath, counts } = await backup(backupDir);
  console.log(`Backup written to ${backupPath}`);
  console.log(counts);

  if (dryRun) {
    console.log("--dry-run: backup only, no records deleted.");
    await store.close();
    return;
  }

  let deleted = 0;
  const failed = [];
  for (const respondent of respondents) {
    try {
      await deleteRespondentCascade(respondent.id);
      deleted++;
    } catch (e) {
      failed.push({ id: respondent.id, error: e.message });
    }
  }

  console.log(`Deleted ${deleted} of ${respondents.length} respondent(s).`);
  if (failed.length) {
    console.log("Failed:");
    for (const f of failed) console.log(`  respondent ${f.id}: ${f.error}`);
  }

  await store.close();
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

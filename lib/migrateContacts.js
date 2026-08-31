#!/usr/bin/env node
//
// Rewrites existing contacts into E.164.
//
//   npm run migrate:contacts             dry run -- shows every before/after, writes nothing
//   npm run migrate:contacts -- --apply  writes the changes
//
// The dry run is not ceremony. Country code comes from the study's `market`,
// and a wrong one would silently rewrite an entire study's numbers into a
// country nobody lives in. Reading the before/after list is the only way to
// catch that, and there is no undo.
//
// Idempotent: a second run reports zero changes. A number the normaliser
// cannot resolve is listed and LEFT ALONE rather than guessed at.

const store = require("./store");
const { canonical } = require("./contact");

const APPLY = process.argv.includes("--apply");

async function main() {
  await store.connect();

  const studies = await store.find("studies", {});
  const marketById = new Map(studies.map((s) => [s.id, s.market]));

  const plan = [];
  let unchanged = 0;

  const respondents = await store.find("respondents", {});
  for (const r of respondents) {
    if (!r.contact) continue;
    const next = canonical(r.contact, { market: marketById.get(r.study_id) });
    if (next === r.contact) { unchanged++; continue; }
    plan.push({ collection: "respondents", id: r.id, label: r.respondent_code, from: r.contact, to: next });
  }

  // Accounts have no study, so they fall back to DEFAULT_COUNTRY_CODE. Set that
  // env var if the pilot's default market ever stops being Nigeria.
  const accounts = await store.find("respondent_accounts", {});
  for (const a of accounts) {
    if (!a.contact) continue;
    const next = canonical(a.contact);
    if (next === a.contact) { unchanged++; continue; }
    plan.push({ collection: "respondent_accounts", id: a.id, label: a.name || `account ${a.id}`, from: a.contact, to: next });
  }

  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN — nothing will be written"}\n`);
  if (!plan.length) {
    console.log(`Nothing to change. ${unchanged} contacts are already canonical.\n`);
    process.exit(0);
  }

  const width = Math.max(...plan.map((p) => p.from.length));
  for (const p of plan) {
    console.log(`  ${p.collection.padEnd(20)} ${String(p.label).padEnd(12)} ${p.from.padEnd(width)}  ->  ${p.to}`);
  }
  console.log(`\n  ${plan.length} to change · ${unchanged} already correct\n`);

  // A rewrite that collides with an existing account would merge two people's
  // identities. Refuse the whole run rather than merge some and not others.
  const accountTargets = plan.filter((p) => p.collection === "respondent_accounts").map((p) => p.to);
  const existing = new Set(accounts.map((a) => a.contact));
  const collisions = accountTargets.filter((t) => existing.has(t));
  if (collisions.length) {
    console.error(`REFUSING TO RUN: ${collisions.length} rewrite(s) would collide with an existing account:`);
    collisions.forEach((c) => console.error(`  ${c}`));
    console.error("\nResolve those by hand first — merging two accounts is not something this script should decide.\n");
    process.exit(1);
  }

  if (!APPLY) {
    console.log("Read the list above. If the country codes are right, run again with --apply\n");
    process.exit(0);
  }

  for (const p of plan) {
    await store.update(p.collection, { id: p.id }, { contact: p.to });
  }
  console.log(`Done. ${plan.length} contacts rewritten.\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});

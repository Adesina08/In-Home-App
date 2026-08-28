const express = require("express");
const mobileAuth = require("../lib/mobileAuth");
const profiles = require("../lib/respondentProfiles");
const store = require("../lib/store");
const { logAudit } = require("../lib/audit");

const router = express.Router();

async function principal(req, res) {
  const p = await mobileAuth.authenticateRequest(req);
  if (!p) {
    res.status(401).json({ error: "Please sign in again." });
    return null;
  }
  return p;
}

async function profileFor(p) {
  if (p.account) return profiles.ensureForAccount(p.account);
  if (p.respondent) return profiles.ensureForRespondent(p.respondent);
  return null;
}

router.get("/", async (req, res) => {
  const p = await principal(req, res);
  if (!p) return;
  const profile = await profileFor(p);
  res.json({
    profile: profiles.publicProfile(profile),
    required: !profile || !profile.completed_at,
    prefillName: (profile && profile.name) || (p.account && p.account.name) || (p.respondent && p.respondent.name) || "",
  });
});

router.put("/", async (req, res) => {
  const p = await principal(req, res);
  if (!p) return;
  const profile = await profileFor(p);
  if (!profile) return res.status(404).json({ error: "Your INICIO profile could not be found." });

  const result = await profiles.completeProfile(profile.id, req.body || {});
  if (!result.ok) return res.status(400).json({ error: "Please check your answers.", fields: result.errors });

  if (p.respondent) {
    await store.update("respondents", { id: p.respondent.id }, { profile_id: profile.id, name: result.profile.name });
  }

  logAudit(
    p.account ? `account:${p.account.id}` : `respondent:${p.respondent.id}`,
    "profile_completed",
    "respondent_profiles",
    profile.id,
    { recontact_consent: result.profile.recontact_consent }
  );

  res.json({ profile: profiles.publicProfile(result.profile), required: false });
});

module.exports = router;

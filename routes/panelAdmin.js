const express = require("express");
const store = require("../lib/store");
const { requireRole } = require("../lib/auth");
const { enrol } = require("../lib/enrolment");
const messaging = require("../lib/whatsapp");
const { appBaseUrl } = require("../lib/urls");
const { logAudit } = require("../lib/audit");

const router = express.Router();
router.use(requireRole("admin"));

function selectedIds(value) {
  return [].concat(value || []).map(Number).filter(Number.isInteger);
}

router.get("/", async (req, res) => {
  const [profiles, accounts, respondents, studies] = await Promise.all([
    store.find("respondent_profiles", { completed_at: { $ne: null } }, { sort: { id: -1 } }),
    store.find("respondent_accounts", {}),
    store.find("respondents", { is_practice: 0 }),
    store.find("studies", {}, { sort: { id: -1 } }),
  ]);

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const enrolmentsByProfile = new Map();
  for (const r of respondents) {
    if (!r.profile_id) continue;
    const list = enrolmentsByProfile.get(r.profile_id) || [];
    list.push(r);
    enrolmentsByProfile.set(r.profile_id, list);
  }

  const q = String(req.query.q || "").trim().toLowerCase();
  const gender = String(req.query.gender || "").trim();
  const education = String(req.query.education || "").trim();
  const recontact = String(req.query.recontact || "").trim();
  const minAge = req.query.min_age ? Number(req.query.min_age) : null;
  const maxAge = req.query.max_age ? Number(req.query.max_age) : null;

  const rows = profiles
    .map((p) => {
      const account = p.account_id ? accountById.get(p.account_id) : null;
      const enrolments = enrolmentsByProfile.get(p.id) || [];
      return {
        ...p,
        contact: account ? account.contact : null,
        studies_count: enrolments.length,
        last_active: enrolments.map((r) => r.created_at).filter(Boolean).sort().reverse()[0] || p.updated_at || p.created_at,
        can_invite: p.recontact_consent === "yes" && !!account,
      };
    })
    .filter((p) => {
      if (q) {
        const haystack = [p.name, p.location, p.occupation, p.contact].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (gender && p.gender !== gender) return false;
      if (education && p.education_level !== education) return false;
      if (recontact && p.recontact_consent !== recontact) return false;
      if (minAge != null && Number(p.age) < minAge) return false;
      if (maxAge != null && Number(p.age) > maxAge) return false;
      return true;
    });

  const inviteStudies = studies.filter((s) =>
    ["live", "draft"].includes(s.status) && ["remote", "hybrid"].includes(s.recruitment_mode)
  );

  res.render("admin/respondent_panel", {
    rows,
    inviteStudies,
    filters: { q: req.query.q || "", gender, education, recontact, min_age: req.query.min_age || "", max_age: req.query.max_age || "" },
    result: req.query.result || null,
  });
});

router.post("/invite", async (req, res) => {
  const ids = selectedIds(req.body.profile_id);
  const studyId = Number(req.body.study_id);
  const study = await store.findOne("studies", { id: studyId });
  if (!study || !["remote", "hybrid"].includes(study.recruitment_mode)) {
    return res.redirect(`/admin/panel?result=${encodeURIComponent("Choose a study that supports remote invitations.")}`);
  }
  if (!ids.length) return res.redirect(`/admin/panel?result=${encodeURIComponent("Select at least one respondent profile.")}`);

  const provider = messaging.getProvider();
  const outcome = { created: 0, sent: 0, skipped: 0, failed: 0 };

  for (const profileId of ids) {
    const profile = await store.findOne("respondent_profiles", { id: profileId });
    if (!profile || profile.recontact_consent !== "yes" || !profile.account_id) {
      outcome.skipped++;
      continue;
    }
    const account = await store.findOne("respondent_accounts", { id: profile.account_id });
    if (!account || !account.contact) {
      outcome.skipped++;
      continue;
    }

    try {
      const result = await enrol({ studyId: study.id, contact: account.contact, name: profile.name });
      if (!result.created) {
        outcome.skipped++;
        continue;
      }
      outcome.created++;
      await store.update("respondents", { id: result.respondent.id }, { profile_id: profile.id });

      const send = await provider.send({
        respondentId: result.respondent.id,
        to: account.contact,
        template: "survey_invite",
        variables: {
          name: profile.name || "there",
          study: study.name,
          link: `${appBaseUrl(req)}/invite/${result.respondent.unique_token}`,
        },
      });
      if (send.ok && !send.simulated) {
        await store.update("respondents", { id: result.respondent.id }, { invite_sent_at: store.nowSql() });
        outcome.sent++;
      } else if (send.simulated) {
        // The enrolment exists and can be copied/shared manually, but don't
        // claim the person received a message when the provider is mocked.
        outcome.failed++;
      } else {
        outcome.failed++;
      }
    } catch (e) {
      outcome.failed++;
      console.error("Panel re-invite failed:", e.message);
    }
  }

  logAudit(req.session.user.email, "panel_invite", "studies", study.id, outcome);
  const message = `${outcome.created} enrolment(s) created; ${outcome.sent} message(s) delivered; ${outcome.skipped} skipped; ${outcome.failed} not sent.`;
  res.redirect(`/admin/panel?result=${encodeURIComponent(message)}`);
});

module.exports = router;

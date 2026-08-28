// First-time invitation sharing must enter /invite/:token, not the direct
// /r/:token diary route. Mounted before the legacy admin/interviewer routers so
// these exact endpoints cannot accidentally bypass Inicio Diary onboarding.
const express = require("express");
const store = require("../lib/store");
const messaging = require("../lib/whatsapp");
const { qrPngToResponse } = require("../lib/qrcode");
const { respondentInviteUrl } = require("../lib/urls");
const { logAudit } = require("../lib/audit");

const router = express.Router();

function staffRoleAllowed(req, roles) {
  return req.session && req.session.user && roles.includes(req.session.user.role);
}

async function adminRespondent(req, res) {
  if (!staffRoleAllowed(req, ["superadmin", "admin", "research"])) {
    res.status(403).render("error", { message: "You do not have permission to do that.", user: req.session.user || null });
    return null;
  }
  const respondent = await store.findOne("respondents", {
    id: Number(req.params.respondentId),
    study_id: Number(req.params.id),
  });
  if (!respondent) {
    res.status(404).render("error", { message: "Respondent not found.", user: req.session.user });
    return null;
  }
  return respondent;
}

async function interviewerRespondent(req, res) {
  if (!staffRoleAllowed(req, ["superadmin", "admin", "research", "interviewer"])) {
    res.status(403).render("error", { message: "You do not have permission to do that.", user: req.session.user || null });
    return null;
  }
  const respondent = await store.findOne("respondents", { id: Number(req.params.id) });
  const study = respondent ? await store.findOne("studies", { id: respondent.study_id }) : null;
  if (!respondent || !study) {
    res.status(404).render("error", { message: "Respondent not found.", user: req.session.user });
    return null;
  }
  if (req.session.user.role === "interviewer" && respondent.interviewer_id !== req.session.user.id) {
    res.status(404).render("error", { message: "Respondent not found.", user: req.session.user });
    return null;
  }
  respondent.study_name = study.name;
  return respondent;
}

// Admin/research invitation QR.
router.get("/admin/studies/:id/respondents/:respondentId/qr.png", async (req, res) => {
  const respondent = await adminRespondent(req, res);
  if (!respondent) return;
  await qrPngToResponse(res, respondentInviteUrl(req, respondent.unique_token));
});

// Admin/research invitation message.
router.post("/admin/studies/:id/respondents/:respondentId/send-link", async (req, res) => {
  const respondent = await adminRespondent(req, res);
  if (!respondent) return;
  const study = await store.findOne("studies", { id: Number(req.params.id) });
  const back = (key, msg) =>
    res.redirect(`/admin/studies/${req.params.id}/respondents/${respondent.id}?${key}=${encodeURIComponent(msg)}`);
  if (!respondent.contact) return back("linkError", "This respondent has no phone number or email on file.");

  const result = await messaging.getProvider().send({
    respondentId: respondent.id,
    to: respondent.contact,
    template: "diary_link_invite",
    variables: {
      name: respondent.name,
      study: study ? study.name : "Inicio Diary",
      link: respondentInviteUrl(req, respondent.unique_token),
    },
  });
  logAudit(req.session.user.email, "send_invitation_link", "respondents", respondent.id, {
    to: respondent.contact,
    ok: !!result.ok,
  });
  if (!result.ok) return back("linkError", result.error || "The invitation could not be sent.");
  if (result.simulated) {
    return back("linkError", `Messaging isn't connected yet, so nothing was delivered to ${respondent.contact} — the invitation was logged only.`);
  }
  return back("linked", `Inicio Diary invitation sent to ${respondent.contact}.`);
});

// Interviewer handover QR.
router.get("/interviewer/respondents/:id/qr.png", async (req, res) => {
  const respondent = await interviewerRespondent(req, res);
  if (!respondent) return;
  await qrPngToResponse(res, respondentInviteUrl(req, respondent.unique_token));
});

// Interviewer handover message.
router.post("/interviewer/respondents/:id/send-link", async (req, res) => {
  const respondent = await interviewerRespondent(req, res);
  if (!respondent) return;
  const back = (key, msg) => res.redirect(`/interviewer/respondents/${respondent.id}?${key}=${encodeURIComponent(msg)}`);
  if (!respondent.contact) return back("sendError", "This respondent has no phone number or email on file. Show them the QR code instead.");

  const result = await messaging.getProvider().send({
    respondentId: respondent.id,
    to: respondent.contact,
    template: "diary_link_invite",
    variables: {
      name: respondent.name,
      study: respondent.study_name,
      link: respondentInviteUrl(req, respondent.unique_token),
    },
  });
  logAudit(req.session.user.email, "send_invitation_link", "respondents", respondent.id, {
    to: respondent.contact,
    ok: !!result.ok,
  });
  if (!result.ok) return back("sendError", result.error || "The invitation could not be sent.");
  if (result.simulated) {
    return back("sendError", `Messaging isn't connected yet, so nothing was actually sent to ${respondent.contact} — the invitation was only logged. Show them the QR code instead.`);
  }
  return back("sent", `Inicio Diary invitation sent to ${respondent.contact}.`);
});

module.exports = router;

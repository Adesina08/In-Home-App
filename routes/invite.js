// The page a cold-invited respondent lands on.
//
// Someone who received an unsolicited text needs three things before being
// asked for anything: what the study is, what taking part actually involves,
// and a way to decline that doesn't require doing anything. Opening straight
// onto a consent form asks for a commitment from a person who has not yet been
// told what they're committing to.

const express = require("express");
const store = require("../lib/store");
const { logAudit } = require("../lib/audit");

const router = express.Router();

function apkUrl() {
  // `public/` is mounted at `/public` in server.js, so the built APK that the
  // deployment workflow places in public/downloads is available at this URL.
  return (process.env.ANDROID_APK_URL || "").trim() || "/public/downloads/inicio-inhome.apk";
}

function whatsappReady() {
  return (process.env.WHATSAPP_BOT_NUMBER || "").trim() || null;
}

function whatsappChatUrl(inviteToken) {
  const configured = whatsappReady();
  if (!configured) return null;
  const digits = configured.replace(/^whatsapp:/i, "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(`JOIN ${inviteToken}`)}`;
}

const CADENCE = {
  realtime: "each time you consume something, as it happens",
  daily: "once a day",
  weekly: "once a week",
  monthly: "once a month",
};

async function loadInvite(req, res) {
  const respondent = await store.findOne("respondents", { unique_token: req.params.token });
  if (!respondent) {
    res.status(404).render("error", { message: "This invitation link is not valid. Please check the link in your message.", user: null });
    return null;
  }
  const study = await store.findOne("studies", { id: respondent.study_id });
  return { respondent, study };
}

router.get("/:token", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;

  if (respondent.consent_status === "given" && respondent.chosen_mode) {
    if (respondent.chosen_mode === "whatsapp") {
      const wa = whatsappChatUrl(respondent.unique_token);
      if (wa) return res.redirect(wa);
    }
    return res.redirect(`/r/${respondent.unique_token}`);
  }

  res.render("invite/welcome", {
    respondent,
    study,
    cadence: CADENCE[study.diary_mode] || "from time to time",
    apkUrl: apkUrl(),
    whatsappNumber: whatsappReady(),
    declined: respondent.activation_status === "disqualified",
    user: null,
  });
});

router.post("/:token/choose", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent } = loaded;
  const requested = ["app", "apk", "whatsapp"].includes(req.body.mode) ? req.body.mode : "app";
  const mode = requested === "apk" ? "app" : requested;
  const preferredChannel = mode === "whatsapp" ? "whatsapp" : "app";

  await store.update("respondents", { id: respondent.id }, {
    chosen_mode: mode,
    preferred_channel: preferredChannel,
  });
  logAudit(`respondent:${respondent.respondent_code}`, "invite_mode_chosen", "respondents", respondent.id, { mode });

  if (mode === "whatsapp") {
    const wa = whatsappChatUrl(respondent.unique_token);
    if (wa) return res.redirect(wa);
    return res.status(503).render("error", {
      message: "WhatsApp participation is not configured for this deployment yet. Please choose the INICIO app instead.",
      user: null,
    });
  }

  // Mobile App is the primary respondent path. Choosing it downloads the
  // current Android APK immediately. After installation the respondent opens
  // INICIO and signs in with the phone number used for this invitation.
  const downloadUrl = apkUrl();
  const separator = downloadUrl.includes("?") ? "&" : "?";
  return res.redirect(`${downloadUrl}${separator}invite=${encodeURIComponent(respondent.unique_token)}`);
});

router.post("/:token/decline", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent } = loaded;
  await store.update(
    "respondents",
    { id: respondent.id },
    {
      activation_status: "disqualified",
      disqualify_reason: "Declined the invitation",
      disqualified_at: store.nowSql(),
    }
  );
  logAudit(`respondent:${respondent.respondent_code}`, "invite_declined", "respondents", respondent.id, {});
  res.render("invite/declined", { study: loaded.study, user: null });
});

module.exports = router;

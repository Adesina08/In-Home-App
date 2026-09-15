const { Resend } = require("resend");
const { renderMessage } = require("./messageTemplates");
const { qrPngBuffer } = require("./qrcode");

function env(name) {
  return String(process.env[name] || "").trim();
}

function fromAddress() {
  const fullAddress = env("RESEND_FROM");
  if (fullAddress) return fullAddress;

  // Keep the split variables as backwards-compatible aliases. SENDER_EMAIL is
  // accepted because some hosting dashboards expose that conventional name.
  const email = env("RESEND_FROM_EMAIL") || env("SENDER_EMAIL");
  if (!email) return "";
  const name = env("RESEND_FROM_NAME") || "INICIO Diary";
  return `${name} <${email}>`;
}

function configured() {
  return Boolean(env("RESEND_API_KEY") && fromAddress() && env("APP_BASE_URL"));
}

function configError() {
  const hasKey = Boolean(env("RESEND_API_KEY"));
  const hasFrom = Boolean(fromAddress());
  const hasBaseUrl = Boolean(env("APP_BASE_URL"));
  if ((!hasKey && !hasFrom) || (hasKey && hasFrom && hasBaseUrl)) return null;
  const missing = [];
  if (!hasKey) missing.push("RESEND_API_KEY");
  if (!hasFrom) missing.push("RESEND_FROM (or RESEND_FROM_EMAIL)");
  if (!hasBaseUrl) missing.push("APP_BASE_URL");
  return `Resend is partially configured. Add ${missing.join(", ")}.`;
}

function signInUrl() {
  return `${String(process.env.APP_BASE_URL || "").replace(/\/+$/, "")}/login`;
}

async function send(message) {
  const client = new Resend(env("RESEND_API_KEY"));
  const { data, error } = await client.emails.send({ from: fromAddress(), ...message });
  if (error) {
    const err = new Error(error.message || "Resend rejected the email.");
    err.code = error.name || "RESEND_ERROR";
    throw err;
  }
  return data;
}

// A shared, deliverability-conscious HTML shell: a real header/footer and a
// reasonable amount of genuine text (a bare one-paragraph email is exactly
// the low-content shape spam filters penalise), inline-styled throughout
// since email clients ignore <style> blocks unpredictably. No tracking
// pixels or unnecessary links -- both invite spam classification on a
// young, low-volume sending domain.
function emailShell({ preheader, bodyHtml }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none;font-size:0;line-height:0;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader || "")}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e9f0;">
<tr><td style="background:#1a2f52;padding:24px 32px;"><span style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.2px;">INICIO Diary</span></td></tr>
<tr><td style="padding:32px;color:#1f2937;font-size:15px;line-height:1.6;">
${bodyHtml}
</td></tr>
<tr><td style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e4e9f0;color:#7d8ba1;font-size:12px;line-height:1.6;">
INICIO Insights &middot; This is a transactional message related to your account or study participation.<br/>
If you weren't expecting this email, you can safely ignore it.
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function button(url, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr><td style="border-radius:8px;background:#2653d6;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a></td></tr></table>`;
}

async function sendCredentials({ name, email, password, role, expiresAt }) {
  if (!configured()) {
    const error = new Error("Resend is not configured. Add RESEND_API_KEY, RESEND_FROM (or RESEND_FROM_EMAIL), and APP_BASE_URL.");
    error.code = "RESEND_NOT_CONFIGURED";
    throw error;
  }
  const displayName = String(name || "there").trim();
  const expiry = new Date(String(expiresAt).replace(" ", "T") + "Z").toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
  const roleLabel = String(role || "").replace(/^\w/, (c) => c.toUpperCase());

  await send({
    to: email,
    subject: "Your INICIO Diary account is ready",
    text: `Hello ${displayName},\n\nAn INICIO Diary account has been set up for you as a ${roleLabel}.\n\nUsername: ${email}\nTemporary password: ${password}\n\nSign in and set your own password here: ${signInUrl()}\n\nThis temporary password expires ${expiry} UTC and must be changed the first time you sign in. If you weren't expecting this account, you can ignore this email.`,
    html: emailShell({
      preheader: `Your temporary sign-in details for INICIO Diary, expiring ${expiry} UTC.`,
      bodyHtml: `
<p style="margin:0 0 16px;">Hello ${escapeHtml(displayName)},</p>
<p style="margin:0 0 16px;">An INICIO Diary account has been set up for you as a <strong>${escapeHtml(roleLabel)}</strong>. Use the temporary details below to sign in — you'll be asked to choose your own password straight away.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 8px;background:#f8fafc;border:1px solid #e4e9f0;border-radius:8px;">
<tr><td style="padding:14px 16px;font-size:13px;color:#5b6b85;width:120px;">Username</td><td style="padding:14px 16px;font-size:14px;font-weight:600;color:#1f2937;">${escapeHtml(email)}</td></tr>
<tr><td style="padding:14px 16px;font-size:13px;color:#5b6b85;border-top:1px solid #e4e9f0;">Temporary password</td><td style="padding:14px 16px;font-size:14px;font-weight:600;color:#1f2937;border-top:1px solid #e4e9f0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(password)}</td></tr>
</table>
${button(signInUrl(), "Sign in to INICIO Diary")}
<p style="margin:0;font-size:13px;color:#5b6b85;">This temporary password expires <strong>${escapeHtml(expiry)} UTC</strong> and must be changed the first time you sign in.</p>`,
    }),
  });
}

async function sendReminder({ name, email, study, link, missed }) {
  if (!configured()) throw new Error("Resend reminder email is not configured.");
  if (!/^\S+@\S+\.\S+$/.test(String(email || ""))) throw new Error("This respondent does not have an email contact.");
  const message = missed ? "Your diary entry is overdue. Please add it when you can." : "It is time to add your next diary entry.";
  await send({
    to: email,
    subject: `${study} — diary reminder`,
    text: `Hello ${name || "there"},\n\n${message}${link ? `\n\nOpen your diary: ${link}` : ""}`,
    html: `<p>Hello ${escapeHtml(name || "there")},</p><p>${escapeHtml(message)}</p>${link ? `<p><a href="${escapeHtml(link)}">Open your diary</a></p>` : ""}`,
  });
  return { ok: true };
}

// Per-template subject line and a genuine, warmer paragraph written for
// email specifically -- not the SMS/WhatsApp body from
// lib/messageTemplates.js reused as-is. SMS has to fit in a GSM-7 segment
// and reads terse by necessity; email has room to actually explain who this
// is from and why the recipient is getting it, which both reads better and
// gives spam filters more genuine content to evaluate against a one-line
// message with a bare link.
const RESPONDENT_EMAIL = {
  survey_invite: ({ name, study, link }) => ({
    subject: `Invitation to take part in ${study || "an INICIO research study"}`,
    intro: `You're invited to take part in <strong>${escapeHtml(study || "a consumer research study")}</strong>, run by INICIO Insights. Taking part is completely optional, and there's no cost or obligation — the invitation link explains what's involved so you can decide.`,
    cta: link ? button(link, "View the invitation") : "",
    closing: "If you'd rather not take part, you don't need to do anything — you can simply ignore this email.",
  }),
  diary_link_invite: ({ name, study, link }) => ({
    subject: `${study || "INICIO Diary"} — your diary link`,
    intro: `Thanks for taking part in <strong>${escapeHtml(study || "this study")}</strong>. Below is your personal diary link — it's unique to you, so please don't forward or share it with anyone else.`,
    cta: link ? button(link, "Open my diary") : "",
    closing: "You can return to this link at any time for the length of the study.",
  }),
  diary_due_reminder: ({ name, study, link }) => ({
    subject: `${study || "INICIO Diary"} — diary reminder`,
    intro: `Just a quick reminder that it's time to log your next <strong>${escapeHtml(study || "diary")}</strong> entry.`,
    cta: link ? button(link, "Add my diary entry") : "",
    closing: "It only takes a couple of minutes — thank you for staying on top of it.",
  }),
  diary_missed_reminder: ({ name, study, link }) => ({
    subject: `${study || "INICIO Diary"} — overdue diary reminder`,
    intro: `Our records show your last <strong>${escapeHtml(study || "diary")}</strong> entry is now overdue. No problem — please add it whenever you get a chance.`,
    cta: link ? button(link, "Add my diary entry") : "",
    closing: "Thanks for your patience, and for continuing to take part.",
  }),
  otp_contact_verification: ({ code, expires_in_minutes }) => ({
    subject: "Your INICIO verification code",
    intro: `Use the code below to verify your contact details. It expires in ${Number(expires_in_minutes) || 10} minutes.`,
    cta: `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="background:#f8fafc;border:1px solid #e4e9f0;border-radius:8px;padding:16px 28px;font-size:26px;font-weight:700;letter-spacing:6px;color:#1a2f52;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(String(code || ""))}</td></tr></table>`,
    closing: "Don't share this code with anyone — INICIO will never ask you for it.",
  }),
};

async function sendRespondentMessage({ to, template, variables = {} }) {
  if (!configured()) throw new Error("Resend is not configured. Add RESEND_API_KEY, RESEND_FROM (or RESEND_FROM_EMAIL), and APP_BASE_URL.");
  if (!/^\S+@\S+\.\S+$/.test(String(to || ""))) throw new Error("Email delivery requires a valid email contact.");
  const build = RESPONDENT_EMAIL[template];
  if (!build) throw new Error(`No email content is defined for message template "${template}".`);
  const { subject, intro, cta, closing } = build(variables);
  const name = String(variables.name || "").trim();

  // The plain-text part reuses the exact SMS/WhatsApp wording -- it's
  // already reviewed, correct and complete -- rather than re-deriving a
  // second plain-text version of the new HTML copy.
  const body = renderMessage(template, variables);

  // Attached as an inline cid: image, not a data: URL -- Gmail, Outlook and
  // several other major clients strip data: URIs from <img src>, so that
  // would just render as a broken image for most recipients.
  const attachments = [];
  let qrHtml = "";
  if (variables.link) {
    attachments.push({
      content: await qrPngBuffer(variables.link, 240),
      filename: "diary-qr-code.png",
      contentType: "image/png",
      inlineContentId: "diary-qr-code",
    });
    qrHtml = `<p style="margin:22px 0 8px;font-size:13px;color:#5b6b85;">Or scan this code with your phone's camera:</p><img src="cid:diary-qr-code" width="160" height="160" alt="QR code linking to the same page as the button above" style="display:block;width:160px;height:160px;border:1px solid #e4e9f0;border-radius:8px;" />`;
  }

  const html = emailShell({
    preheader: intro.replace(/<[^>]+>/g, ""),
    bodyHtml: `<p style="margin:0 0 16px;">Hi${name ? ` ${escapeHtml(name)}` : ""},</p><p style="margin:0 0 4px;">${intro}</p>${cta}${qrHtml}<p style="margin:16px 0 0;font-size:13px;color:#5b6b85;">${closing}</p>`,
  });

  const data = await send({ to, subject, text: body, html, ...(attachments.length ? { attachments } : {}) });
  return { ok: true, body, providerMessageId: data ? data.id || null : null };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

module.exports = { configured, configError, fromAddress, sendCredentials, sendReminder, sendRespondentMessage };

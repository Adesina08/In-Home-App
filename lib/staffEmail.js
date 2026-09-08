const { Resend } = require("resend");
const { renderMessage } = require("./messageTemplates");

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

async function sendCredentials({ name, email, password, role, expiresAt }) {
  if (!configured()) {
    const error = new Error("Resend is not configured. Add RESEND_API_KEY, RESEND_FROM (or RESEND_FROM_EMAIL), and APP_BASE_URL.");
    error.code = "RESEND_NOT_CONFIGURED";
    throw error;
  }
  const displayName = String(name || "there").trim();
  const expiry = new Date(String(expiresAt).replace(" ", "T") + "Z").toLocaleString("en-GB", { timeZone: "UTC" });
  await send({
    to: email,
    subject: "Your INICIO Diary account",
    text: `Hello ${displayName},\n\nYour INICIO Diary account is ready.\n\nUsername: ${email}\nTemporary password: ${password}\nRole: ${role}\nSign in: ${signInUrl()}\n\nThis temporary password expires at ${expiry} UTC and must be changed when you first sign in.`,
    html: `<p>Hello ${escapeHtml(displayName)},</p><p>Your INICIO Diary account is ready.</p><table role="presentation"><tr><td><strong>Username</strong></td><td>${escapeHtml(email)}</td></tr><tr><td><strong>Temporary password</strong></td><td><code>${escapeHtml(password)}</code></td></tr><tr><td><strong>Role</strong></td><td>${escapeHtml(role)}</td></tr></table><p><a href="${escapeHtml(signInUrl())}">Sign in to INICIO Diary</a></p><p>This temporary password expires at ${escapeHtml(expiry)} UTC and must be changed when you first sign in.</p>`,
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

const RESPONDENT_SUBJECTS = {
  survey_invite: ({ study }) => `Invitation to ${study || "an INICIO research study"}`,
  diary_link_invite: ({ study }) => `${study || "INICIO Diary"} — your diary link`,
  diary_due_reminder: ({ study }) => `${study || "INICIO Diary"} — diary reminder`,
  diary_missed_reminder: ({ study }) => `${study || "INICIO Diary"} — overdue diary reminder`,
  otp_contact_verification: () => "Your INICIO verification code",
};

async function sendRespondentMessage({ to, template, variables = {} }) {
  if (!configured()) throw new Error("Resend is not configured. Add RESEND_API_KEY, RESEND_FROM (or RESEND_FROM_EMAIL), and APP_BASE_URL.");
  if (!/^\S+@\S+\.\S+$/.test(String(to || ""))) throw new Error("Email delivery requires a valid email contact.");
  const subject = RESPONDENT_SUBJECTS[template];
  if (!subject) throw new Error(`No email subject is defined for message template "${template}".`);
  const body = renderMessage(template, variables);
  const data = await send({
    to,
    subject: subject(variables),
    text: body,
    html: `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>`,
  });
  return { ok: true, body, providerMessageId: data ? data.id || null : null };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

module.exports = { configured, configError, fromAddress, sendCredentials, sendReminder, sendRespondentMessage };

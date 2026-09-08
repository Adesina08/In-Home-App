const sgMail = require("@sendgrid/mail");
const { renderMessage } = require("./messageTemplates");

function configured() {
  return Boolean(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL && process.env.APP_BASE_URL);
}

function configError() {
  const present = ["SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL", "APP_BASE_URL"].filter((key) => String(process.env[key] || "").trim());
  if (!present.length || configured()) return null;
  const missing = ["SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL", "APP_BASE_URL"].filter((key) => !String(process.env[key] || "").trim());
  return `SendGrid is partially configured. Add ${missing.join(", ")}.`;
}

function signInUrl() {
  return `${String(process.env.APP_BASE_URL || "").replace(/\/+$/, "")}/login`;
}

async function sendCredentials({ name, email, password, role, expiresAt }) {
  if (!configured()) {
    const error = new Error("SendGrid is not configured. Add SENDGRID_API_KEY, SENDGRID_FROM_EMAIL and APP_BASE_URL.");
    error.code = "SENDGRID_NOT_CONFIGURED";
    throw error;
  }
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const from = {
    email: process.env.SENDGRID_FROM_EMAIL,
    name: process.env.SENDGRID_FROM_NAME || "INICIO Diary",
  };
  const displayName = String(name || "there").trim();
  const expiry = new Date(String(expiresAt).replace(" ", "T") + "Z").toLocaleString("en-GB", { timeZone: "UTC" });
  await sgMail.send({
    to: email,
    from,
    subject: "Your INICIO Diary account",
    text: `Hello ${displayName},\n\nYour INICIO Diary account is ready.\n\nUsername: ${email}\nTemporary password: ${password}\nRole: ${role}\nSign in: ${signInUrl()}\n\nThis temporary password expires at ${expiry} UTC and must be changed when you first sign in.`,
    html: `<p>Hello ${escapeHtml(displayName)},</p><p>Your INICIO Diary account is ready.</p><table role="presentation"><tr><td><strong>Username</strong></td><td>${escapeHtml(email)}</td></tr><tr><td><strong>Temporary password</strong></td><td><code>${escapeHtml(password)}</code></td></tr><tr><td><strong>Role</strong></td><td>${escapeHtml(role)}</td></tr></table><p><a href="${escapeHtml(signInUrl())}">Sign in to INICIO Diary</a></p><p>This temporary password expires at ${escapeHtml(expiry)} UTC and must be changed when you first sign in.</p>`,
  });
}

async function sendReminder({ name, email, study, link, missed }) {
  if (!configured()) throw new Error("SendGrid reminder email is not configured.");
  if (!/^\S+@\S+\.\S+$/.test(String(email || ""))) throw new Error("This respondent does not have an email contact.");
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const message = missed ? "Your diary entry is overdue. Please add it when you can." : "It is time to add your next diary entry.";
  await sgMail.send({
    to: email,
    from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME || "INICIO Diary" },
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
  if (!configured()) throw new Error("SendGrid is not configured. Add SENDGRID_API_KEY, SENDGRID_FROM_EMAIL and APP_BASE_URL.");
  if (!/^\S+@\S+\.\S+$/.test(String(to || ""))) throw new Error("Email delivery requires a valid email contact.");
  const subject = RESPONDENT_SUBJECTS[template];
  if (!subject) throw new Error(`No email subject is defined for message template "${template}".`);
  const body = renderMessage(template, variables);
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const [response] = await sgMail.send({
    to,
    from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME || "INICIO Diary" },
    subject: subject(variables),
    text: body,
    html: `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>`,
  });
  return { ok: true, body, providerMessageId: response && response.headers ? response.headers["x-message-id"] || null : null };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

module.exports = { configured, configError, sendCredentials, sendReminder, sendRespondentMessage };

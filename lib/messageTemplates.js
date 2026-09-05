// The actual words that go out to a respondent's phone.
//
// Until now the messaging adapter passed a template *name* and a bag of
// variables to a provider that never rendered them -- fine while every send
// was simulated into an outbox, useless the moment a real provider has to put
// characters into an SMS. This is that missing half: one place where the body
// of each message lives, so the wording can be reviewed and changed without
// touching provider code.
//
// Deliberately plain text with no markup. SMS has no formatting, and a
// WhatsApp template message is approved by Meta as a fixed string with
// numbered placeholders -- anything clever here would simply be stripped or
// rejected.
//
// Keep these short. An SMS segment is 160 GSM-7 characters; longer messages
// still send but are billed per segment, and a diary link is already long.

const TEMPLATES = {
  // The first message a cold-invited respondent ever receives. It has to say
  // who it's from and make participation optional in the same breath -- an
  // unsolicited text with a bare link reads as a scam, and gets deleted.
  survey_invite: ({ name, study, link }) =>
    `Hi${name ? ` ${name}` : ""}, you've been invited to take part in ${study}, a consumer research study. If you'd like to join, open ${link} to see what's involved. No obligation.`,

  diary_link_invite: ({ name, study, link }) =>
    `Hi${name ? ` ${name}` : ""}, thanks for taking part in ${study}. Open your personal diary here: ${link} — it's just for you, please don't share it.`,

  diary_due_reminder: ({ name, study, link }) =>
    `Hi${name ? ` ${name}` : ""}, it's time to log your ${study} diary entry.${link ? ` ${link}` : ""}`,

  diary_missed_reminder: ({ name, study, link }) =>
    `Hi${name ? ` ${name}` : ""}, you're overdue to log your ${study} diary entry. Please add one when you can.${link ? ` ${link}` : ""}`,

  otp_contact_verification: ({ code, expires_in_minutes }) =>
    `Your INICIO verification code is ${code}. It expires in ${expires_in_minutes || 10} minutes. Don't share it with anyone.`,
};

/**
 * Render a template to the text a phone will actually display.
 *
 * An unknown template name is a programming error, not a runtime condition, so
 * it throws rather than silently sending an empty message -- a respondent
 * receiving a blank SMS is worse than a send that fails loudly.
 */
function renderMessage(template, variables = {}) {
  const fn = TEMPLATES[template];
  if (!fn) throw new Error(`No message body defined for template "${template}" (see lib/messageTemplates.js).`);
  return fn(variables);
}

function hasTemplate(template) {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, template);
}

module.exports = { renderMessage, hasTemplate, TEMPLATE_NAMES: Object.keys(TEMPLATES) };

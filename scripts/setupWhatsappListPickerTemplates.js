// One-time setup: creates the WhatsApp List Picker Content templates used
// for single-select diary questions, one per option count from 2 to Meta's
// 10-item cap (lib/whatsappDiary.js only offers a List Picker within that
// range). Each item's visible text is a variable ({{2}}, {{3}}, ...) so one
// template per size serves any question with that many options; the number
// of rows itself is fixed at creation time, which is why a range of sizes is
// needed instead of one template.
//
// These are session-only content: Twilio does not allow List Picker to be
// submitted for WhatsApp/Meta approval, so they only work as a reply inside
// a conversation the respondent already opened -- exactly how every
// WhatsApp diary conversation starts (see routes/whatsappWebhook.js).
//
// Usage: node scripts/setupWhatsappListPickerTemplates.js
// Prints a JSON object mapping option count -> Content SID. Paste it into
// TWILIO_WHATSAPP_LIST_PICKER_SIDS in .env.
//
// Re-running this creates a new set of templates rather than updating the
// existing ones (the Content API has no update-by-name); delete the old
// ones in the Twilio console (Messaging > Templates) if regenerating.

require("dotenv").config();

const MIN_SIZE = 2;
const MAX_SIZE = 10;

function auth() {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = (process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set to create Content templates.");
  }
  return "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64");
}

async function createTemplate(size, authHeader) {
  const variables = { "1": "question text" };
  const items = [];
  for (let i = 1; i <= size; i += 1) {
    variables[String(i + 1)] = `item ${i}`;
    items.push({ item: `{{${i + 1}}}`, id: `opt_${i}` });
  }

  const resp = await fetch("https://content.twilio.com/v1/Content", {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      friendly_name: `inicio_diary_select_${size}`,
      language: "en",
      variables,
      types: { "twilio/list-picker": { body: "{{1}}", button: "Select", items } },
    }),
  });
  const body = await resp.json();
  if (resp.status !== 201) {
    throw new Error(`size ${size}: Twilio returned HTTP ${resp.status}: ${JSON.stringify(body)}`);
  }
  return body.sid;
}

async function main() {
  const authHeader = auth();
  const sidByCount = {};
  for (let size = MIN_SIZE; size <= MAX_SIZE; size += 1) {
    const sid = await createTemplate(size, authHeader);
    sidByCount[String(size)] = sid;
    process.stdout.write(`size ${size} -> ${sid}\n`);
  }
  process.stdout.write("\nTWILIO_WHATSAPP_LIST_PICKER_SIDS=" + JSON.stringify(sidByCount) + "\n");
}

main().catch((error) => {
  process.stderr.write(`FAILED: ${error.message}\n`);
  process.exitCode = 1;
});

// Create the Twilio whatsapp/flows Content Template that points at an already
// published Meta Flow. This creates content only; review and submit its
// WhatsApp approval request in Twilio before using it for cold reminders.
//
// Usage: node scripts/setupWhatsappFlowTemplate.js <study-id> <meta-flow-id>

require("dotenv").config();

const store = require("../lib/store");
const { loadQuestionnaire } = require("../lib/questionnaire");
const { compileFlow } = require("../lib/whatsappFlow");

function authHeader() {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required.");
  }
  return "Basic " + Buffer.from(accountSid + ":" + authToken).toString("base64");
}

function configuredMapping() {
  const raw = String(process.env.TWILIO_WHATSAPP_FLOW_CONTENT_SIDS || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    throw new Error("TWILIO_WHATSAPP_FLOW_CONTENT_SIDS must be valid JSON before it can be updated.");
  }
}

async function main() {
  const studyId = Number(process.argv[2]);
  const metaFlowId = String(process.argv[3] || "").trim();
  if (!Number.isInteger(studyId) || studyId < 1 || !metaFlowId) {
    throw new Error("Usage: node scripts/setupWhatsappFlowTemplate.js <study-id> <meta-flow-id>");
  }

  await store.connect();
  try {
    const study = await store.findOne("studies", { id: studyId });
    if (!study) throw new Error("Study not found: " + studyId);
    const questionnaire = await loadQuestionnaire(study.id, { respondentId: 0 });
    const compiled = compileFlow({ study, questionnaire });
    const version = compiled.questionnaireVersion;

    const response = await fetch("https://content.twilio.com/v1/Content", {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        friendly_name: "inicio_diary_flow_" + study.id + "_v" + version,
        language: "en",
        variables: { "1": "inicio-signed-flow-token" },
        types: {
          "whatsapp/flows": {
            body: (String(study.name || "INICIO") + " diary is ready.").slice(0, 1024),
            button_text: "Open diary",
            flow_id: metaFlowId,
            flow_token: "{{1}}",
            flow_first_page_id: compiled.firstScreenId,
          },
        },
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status !== 201 || !body.sid) {
      throw new Error("Twilio returned HTTP " + response.status + ": " + JSON.stringify(body));
    }

    const mapping = configuredMapping();
    mapping[String(study.id) + ":" + String(version)] = body.sid;
    process.stdout.write("Created " + body.sid + " for study " + study.id + " v" + version + ".\n");
    process.stdout.write("TWILIO_WHATSAPP_FLOW_CONTENT_SIDS=" + JSON.stringify(mapping) + "\n");
    process.stdout.write("Review and submit this Content SID for WhatsApp approval before using cold reminders.\n");
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write("FAILED: " + error.message + "\n");
  process.exitCode = 1;
});

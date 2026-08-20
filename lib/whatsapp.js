// Pluggable WhatsApp provider.
//
// PRODUCTION HOOKUP POINT: set WHATSAPP_PROVIDER=meta_cloud_api (or your provider) in .env
// and fill WHATSAPP_API_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TEMPLATE_NAMESPACE.
// Until real credentials are supplied, every "send" is only logged to the
// whatsapp_outbox table and surfaced in the Admin > WhatsApp Outbox screen —
// nothing is actually sent. See PRODUCTION_READINESS.md, section B1.

const db = require("./db");

class MockWhatsAppProvider {
  async send({ respondentId, to, template, variables }) {
    db.prepare(
      `INSERT INTO whatsapp_outbox (respondent_id, template, payload_json, provider, status)
       VALUES (?, ?, ?, 'mock', 'simulated')`
    ).run(respondentId || null, template, JSON.stringify({ to, variables }));
    return { ok: true, simulated: true };
  }
}

class MetaCloudApiProvider {
  constructor() {
    this.token = process.env.WHATSAPP_API_TOKEN;
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    this.templateNamespace = process.env.WHATSAPP_TEMPLATE_NAMESPACE;
    if (!this.token || !this.phoneNumberId) {
      throw new Error(
        "WHATSAPP_API_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing. Set real credentials in .env (see PRODUCTION_READINESS.md B1) or leave WHATSAPP_PROVIDER=mock."
      );
    }
  }
  async send({ respondentId, to, template, variables }) {
    // Real implementation would call the Meta Cloud API / Twilio / provider REST endpoint here
    // using this.token / this.phoneNumberId and the approved template name + variables.
    // Left unimplemented in this prototype since no real credentials are available.
    const resp = { ok: false, error: "Real WhatsApp send not implemented in prototype. Configure a real provider call here." };
    db.prepare(
      `INSERT INTO whatsapp_outbox (respondent_id, template, payload_json, provider, status)
       VALUES (?, ?, ?, 'meta_cloud_api', 'failed')`
    ).run(respondentId || null, template, JSON.stringify({ to, variables, error: resp.error }));
    return resp;
  }
}

function getProvider() {
  const providerName = process.env.WHATSAPP_PROVIDER || "mock";
  if (providerName === "meta_cloud_api") return new MetaCloudApiProvider();
  return new MockWhatsAppProvider();
}

module.exports = { getProvider };

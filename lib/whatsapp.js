// Pluggable outbound messaging provider (SMS / WhatsApp).
//
// Named whatsapp.js for history; it now carries SMS too, since SMS is what
// actually works on day one -- see the Twilio provider below.
//
// PRODUCTION HOOKUP POINT: set MESSAGING_PROVIDER (or the older
// WHATSAPP_PROVIDER) to `twilio` and fill the TWILIO_* variables. Until a real
// provider is configured, every send is only recorded in the whatsapp_outbox
// table and surfaced in Admin > WhatsApp Outbox -- nothing leaves the server.
// See PRODUCTION_READINESS.md, section B1.

const db = require("./db");
const { renderMessage } = require("./messageTemplates");

function record({ respondentId, template, to, variables, provider, status, body, error, providerMessageId }) {
  db.prepare(
    `INSERT INTO whatsapp_outbox (respondent_id, template, payload_json, provider, status)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    respondentId || null,
    template,
    JSON.stringify({ to, variables, body, error, providerMessageId }),
    provider,
    status
  );
}

class MockProvider {
  get name() {
    return "mock";
  }
  get isReal() {
    return false;
  }
  async send({ respondentId, to, template, variables }) {
    let body = null;
    let error = null;
    try {
      body = renderMessage(template, variables);
    } catch (e) {
      error = e.message;
    }
    record({ respondentId, template, to, variables, provider: "mock", status: error ? "failed" : "simulated", body, error });
    return error ? { ok: false, simulated: true, error } : { ok: true, simulated: true, body };
  }
}

class TwilioProvider {
  constructor() {
    this.accountSid = process.env.TWILIO_ACCOUNT_SID;

    const apiKeySid = process.env.TWILIO_API_KEY_SID;
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    // Twilio supports two distinct Basic-auth pairs. Never mix them:
    //   API Key SID (SK...) + that key's secret
    //   Account SID (AC...) + account Auth Token
    const hasApiKeySid = !!apiKeySid;
    const hasApiKeySecret = !!apiKeySecret;

    if (hasApiKeySid !== hasApiKeySecret) {
      throw new Error(
        "Twilio API-key authentication is only partially configured. Set both TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET, or clear both and use TWILIO_ACCOUNT_SID with TWILIO_AUTH_TOKEN."
      );
    }

    if (hasApiKeySid) {
      if (!this.accountSid) {
        throw new Error(
          "TWILIO_ACCOUNT_SID is required with TWILIO_API_KEY_SID/TWILIO_API_KEY_SECRET because the Messages API URL is scoped to the account."
        );
      }
      this.authUser = apiKeySid;
      this.authPass = apiKeySecret;
    } else {
      if (!this.accountSid || !authToken) {
        throw new Error(
          "Set either TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (with TWILIO_ACCOUNT_SID), or TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN when MESSAGING_PROVIDER=twilio. See PRODUCTION_READINESS.md B1."
        );
      }
      this.authUser = this.accountSid;
      this.authPass = authToken;
    }

    this.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    this.from = process.env.TWILIO_FROM_NUMBER;
    this.channel = (process.env.TWILIO_CHANNEL || "sms").toLowerCase();

    if (!this.messagingServiceSid && !this.from) {
      throw new Error(
        "Set TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_FROM_NUMBER when MESSAGING_PROVIDER=twilio. See PRODUCTION_READINESS.md B1."
      );
    }
    if (this.channel !== "sms" && this.channel !== "whatsapp") {
      throw new Error(`TWILIO_CHANNEL must be "sms" or "whatsapp", got "${this.channel}".`);
    }
  }

  get name() {
    return `twilio_${this.channel}`;
  }
  get isReal() {
    return true;
  }

  address(number) {
    const trimmed = String(number || "").trim();
    if (this.channel !== "whatsapp") return trimmed;
    return trimmed.startsWith("whatsapp:") ? trimmed : `whatsapp:${trimmed}`;
  }

  async send({ respondentId, to, template, variables }) {
    let body;
    try {
      body = renderMessage(template, variables);
    } catch (e) {
      record({ respondentId, template, to, variables, provider: this.name, status: "failed", error: e.message });
      return { ok: false, error: e.message };
    }

    const trimmed = String(to || "").trim();
    if (!/^\+[1-9]\d{6,14}$/.test(trimmed.replace(/^whatsapp:/, ""))) {
      const error = `"${to}" is not in international format. Numbers must start with + and the country code (e.g. +2348012345678).`;
      record({ respondentId, template, to, variables, provider: this.name, status: "failed", body, error });
      return { ok: false, error };
    }

    const form = new URLSearchParams({ To: this.address(trimmed), Body: body });
    if (this.messagingServiceSid) form.set("MessagingServiceSid", this.messagingServiceSid);
    else form.set("From", this.address(this.from));

    try {
      const resp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: "Basic " + Buffer.from(`${this.authUser}:${this.authPass}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form,
          signal: AbortSignal.timeout(15000),
        }
      );
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const error = payload.message || `Twilio returned HTTP ${resp.status}.`;
        record({ respondentId, template, to, variables, provider: this.name, status: "failed", body, error });
        return { ok: false, error };
      }
      record({
        respondentId, template, to, variables,
        provider: this.name, status: "sent", body, providerMessageId: payload.sid || null,
      });
      return { ok: true, providerMessageId: payload.sid || null, body };
    } catch (e) {
      const error = e.name === "TimeoutError" ? "Twilio did not respond within 15 seconds." : e.message;
      record({ respondentId, template, to, variables, provider: this.name, status: "failed", body, error });
      return { ok: false, error };
    }
  }
}

class MetaCloudApiProvider {
  get name() {
    return "meta_cloud_api";
  }
  get isReal() {
    return false;
  }
  async send({ respondentId, to, template, variables }) {
    const error =
      "The Meta Cloud API provider was never implemented. Use MESSAGING_PROVIDER=twilio, or implement the send call here.";
    record({ respondentId, template, to, variables, provider: "meta_cloud_api", status: "failed", error });
    return { ok: false, error };
  }
}

function providerName() {
  return (process.env.MESSAGING_PROVIDER || process.env.WHATSAPP_PROVIDER || "mock").toLowerCase();
}

function getProvider() {
  const name = providerName();
  if (name === "twilio") return new TwilioProvider();
  if (name === "meta_cloud_api") return new MetaCloudApiProvider();
  return new MockProvider();
}

function isRealMessagingConfigured() {
  try {
    return getProvider().isReal;
  } catch {
    return false;
  }
}

function messagingConfigError() {
  if (providerName() === "mock") return null;
  try {
    getProvider();
    return null;
  } catch (e) {
    return e.message;
  }
}

module.exports = { getProvider, isRealMessagingConfigured, messagingConfigError, providerName };

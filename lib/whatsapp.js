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
    // Renders the body even though nothing is sent, so the outbox shows the
    // exact text a respondent would have received -- that's what makes the
    // outbox useful for reviewing wording before a provider is connected, and
    // it means a broken template fails here in testing rather than in the field.
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

/**
 * Twilio Messages API -- SMS by default, WhatsApp opt-in.
 *
 * SMS is the default channel on purpose. WhatsApp requires an approved
 * business sender and message templates pre-approved by Meta; SMS needs
 * neither, so a study can start sending diary links the day the account is
 * connected instead of waiting on template review.
 *
 * Uses fetch and Basic auth rather than the twilio npm package: it's one form
 * POST, and it keeps a third-party dependency (and its transitive tree) out of
 * a codebase that a client's security review has to read.
 */
class TwilioProvider {
  constructor() {
    this.accountSid = process.env.TWILIO_ACCOUNT_SID;
    // A Twilio API key (SK...) is preferred over the account auth token: it can
    // be revoked on its own if this app is ever compromised, without breaking
    // the other applications on the same Twilio account.
    this.authUser = process.env.TWILIO_API_KEY_SID || this.accountSid;
    this.authPass = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN;
    // Exactly one of these identifies the sender. A Messaging Service is
    // preferred -- the sender number can then be changed in the Twilio console
    // without redeploying this app.
    this.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    this.from = process.env.TWILIO_FROM_NUMBER;
    this.channel = (process.env.TWILIO_CHANNEL || "sms").toLowerCase();

    if (!this.accountSid || !this.authPass) {
      throw new Error(
        "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (or TWILIO_API_KEY_SID/TWILIO_API_KEY_SECRET) are required when MESSAGING_PROVIDER=twilio. See PRODUCTION_READINESS.md B1."
      );
    }
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

  // WhatsApp addresses are the same E.164 number with a whatsapp: prefix.
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

    // Twilio requires E.164 ("+2348012345678"). A local-format number is a
    // configuration/data problem that would come back as an opaque 21211 from
    // the API, so it's caught here with a message a person can act on.
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
          // A hung provider must never hold a diary reminder run or an
          // interviewer's browser open indefinitely.
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
      // Network failure, DNS, timeout. Recorded and returned rather than
      // thrown: a failed reminder must not abort the whole reminder run, and a
      // failed link-send must not lose the interviewer's page.
      const error = e.name === "TimeoutError" ? "Twilio did not respond within 15 seconds." : e.message;
      record({ respondentId, template, to, variables, provider: this.name, status: "failed", body, error });
      return { ok: false, error };
    }
  }
}

// Kept so an existing WHATSAPP_PROVIDER=meta_cloud_api deployment fails with a
// useful message rather than silently falling back to the mock.
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

/**
 * Is a real provider configured and usable? Used by the screens that offer to
 * message a respondent, so they can say plainly that nothing will actually be
 * delivered yet instead of showing a button that quietly does nothing.
 */
function isRealMessagingConfigured() {
  try {
    return getProvider().isReal;
  } catch {
    return false; // configured as real but misconfigured -- treat as not usable
  }
}

/** The specific reason a real provider can't be built, for the admin screen. */
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

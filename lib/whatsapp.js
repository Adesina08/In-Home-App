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

function env(name) {
  const value = process.env[name];
  return value == null ? "" : String(value).trim();
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
    this.accountSid = env("TWILIO_ACCOUNT_SID");
    this.apiKeySid = env("TWILIO_API_KEY_SID");
    this.apiKeySecret = env("TWILIO_API_KEY_SECRET");
    this.authToken = env("TWILIO_AUTH_TOKEN");

    const hasApiKeySid = !!this.apiKeySid;
    const hasApiKeySecret = !!this.apiKeySecret;
    if (hasApiKeySid !== hasApiKeySecret) {
      throw new Error(
        "Twilio API-key authentication is only partially configured. Set both TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET, or clear both."
      );
    }
    if (!this.accountSid) {
      throw new Error("TWILIO_ACCOUNT_SID is required when MESSAGING_PROVIDER=twilio.");
    }
    if (!/^AC[0-9a-fA-F]{32}$/.test(this.accountSid)) {
      throw new Error("TWILIO_ACCOUNT_SID must be a valid Twilio Account SID beginning with AC.");
    }
    if (hasApiKeySid && !/^SK[0-9a-fA-F]{32}$/.test(this.apiKeySid)) {
      throw new Error("TWILIO_API_KEY_SID must be a valid Twilio API Key SID beginning with SK.");
    }
    if (!this.authToken && !hasApiKeySid) {
      throw new Error(
        "No Twilio authentication credentials are configured. Set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN, or TWILIO_ACCOUNT_SID + TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET."
      );
    }

    // API credentials are Region-specific in Twilio. The default Twilio API
    // hostname targets US1. For a non-US1 key/token, set both TWILIO_REGION and
    // TWILIO_EDGE (for example ie1+dublin or au1+sydney).
    this.region = (env("TWILIO_REGION") || "us1").toLowerCase();
    this.edge = env("TWILIO_EDGE").toLowerCase();
    if (this.region !== "us1" && !this.edge) {
      throw new Error(
        `TWILIO_REGION=${this.region} requires TWILIO_EDGE as well (for example ie1+dublin or au1+sydney). Twilio credentials are region-specific.`
      );
    }

    this.messagingServiceSid = env("TWILIO_MESSAGING_SERVICE_SID");
    this.from = env("TWILIO_FROM_NUMBER");
    this.channel = (env("TWILIO_CHANNEL") || "sms").toLowerCase();
    if (this.messagingServiceSid && !/^MG[0-9a-fA-F]{32}$/.test(this.messagingServiceSid)) {
      throw new Error("TWILIO_MESSAGING_SERVICE_SID must be a valid Messaging Service SID beginning with MG.");
    }
    if (!this.messagingServiceSid && !this.from) {
      throw new Error(
        "Set TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_FROM_NUMBER when MESSAGING_PROVIDER=twilio. See PRODUCTION_READINESS.md B1."
      );
    }
    if (this.channel !== "sms" && this.channel !== "whatsapp") {
      throw new Error(`TWILIO_CHANNEL must be \"sms\" or \"whatsapp\", got \"${this.channel}\".`);
    }

    // auto: prefer the Account Auth Token if present because it is the easiest
    // recovery path for a stale/region-mismatched API key. Production can force
    // api_key once the key has been verified.
    this.authMode = (env("TWILIO_AUTH_MODE") || "auto").toLowerCase();
    if (!["auto", "auth_token", "api_key"].includes(this.authMode)) {
      throw new Error("TWILIO_AUTH_MODE must be auto, auth_token, or api_key.");
    }
    if (this.authMode === "auth_token" && !this.authToken) {
      throw new Error("TWILIO_AUTH_MODE=auth_token requires TWILIO_AUTH_TOKEN.");
    }
    if (this.authMode === "api_key" && !hasApiKeySid) {
      throw new Error("TWILIO_AUTH_MODE=api_key requires TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET.");
    }
  }

  get name() {
    return `twilio_${this.channel}`;
  }
  get isReal() {
    return true;
  }

  apiHost() {
    if (this.region === "us1" && !this.edge) return "api.twilio.com";
    return `api.${this.edge}.${this.region}.twilio.com`;
  }

  credentialsInOrder() {
    const apiKey = this.apiKeySid && this.apiKeySecret
      ? { mode: "api_key", user: this.apiKeySid, pass: this.apiKeySecret }
      : null;
    const authToken = this.authToken
      ? { mode: "auth_token", user: this.accountSid, pass: this.authToken }
      : null;

    if (this.authMode === "api_key") return [apiKey].filter(Boolean);
    if (this.authMode === "auth_token") return [authToken].filter(Boolean);

    // In auto mode, use an Account Auth Token first if one exists; if Twilio
    // rejects it with 401, try the API key. If there is no Auth Token (as in
    // many production deployments), use the API key directly.
    return [authToken, apiKey].filter(Boolean);
  }

  address(number) {
    const trimmed = String(number || "").trim();
    if (this.channel !== "whatsapp") return trimmed;
    return trimmed.startsWith("whatsapp:") ? trimmed : `whatsapp:${trimmed}`;
  }

  async requestMessage(form, credentials) {
    const resp = await fetch(
      `https://${this.apiHost()}/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${credentials.user}:${credentials.pass}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
        signal: AbortSignal.timeout(15000),
      }
    );
    const payload = await resp.json().catch(() => ({}));
    return { resp, payload, mode: credentials.mode };
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
      const error = `\"${to}\" is not in international format. Numbers must start with + and the country code (e.g. +2348012345678).`;
      record({ respondentId, template, to, variables, provider: this.name, status: "failed", body, error });
      return { ok: false, error };
    }

    const form = new URLSearchParams({ To: this.address(trimmed), Body: body });
    if (this.messagingServiceSid) form.set("MessagingServiceSid", this.messagingServiceSid);
    else form.set("From", this.address(this.from));

    const credentials = this.credentialsInOrder();
    let last = null;

    try {
      for (let index = 0; index < credentials.length; index += 1) {
        last = await this.requestMessage(form, credentials[index]);

        if (last.resp.ok) {
          record({
            respondentId,
            template,
            to,
            variables,
            provider: this.name,
            status: "sent",
            body,
            providerMessageId: last.payload.sid || null,
          });
          return { ok: true, providerMessageId: last.payload.sid || null, body };
        }

        // Only authentication failures should try another credential family.
        // A 400/403/429/etc. is a real request/account problem and retrying with
        // another password would create duplicate log noise without helping.
        if (last.resp.status !== 401) break;
      }

      const rawError = (last && last.payload && last.payload.message) ||
        `Twilio returned HTTP ${last ? last.resp.status : "unknown"}.`;
      const attempted = credentials.map(c => c.mode).join(" then ");
      const diagnostic = `${rawError} [auth=${attempted}; region=${this.region}${this.edge ? `; edge=${this.edge}` : ""}]`;

      record({ respondentId, template, to, variables, provider: this.name, status: "failed", body, error: diagnostic });

      if (last && last.resp.status === 401) {
        const noFallback = credentials.length === 1 ? " No second credential method is configured as a fallback." : "";
        return {
          ok: false,
          error:
            `Twilio authentication failed.${noFallback} Check that the credential pair belongs to this Twilio account and Region (${this.region.toUpperCase()}).`,
        };
      }
      return { ok: false, error: rawError };
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

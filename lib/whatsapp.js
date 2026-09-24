// Pluggable outbound messaging provider (SMS / WhatsApp / email).
//
// Named whatsapp.js for history; it now carries SMS and email too, since SMS
// is what actually works on day one -- see the Twilio provider below.
//
// PRODUCTION HOOKUP POINT: set MESSAGING_PROVIDER (or the older
// WHATSAPP_PROVIDER) to `twilio` and fill the TWILIO_* variables. Until a real
// provider is configured, every send is only recorded in the whatsapp_outbox
// table and surfaced in Admin > WhatsApp Outbox -- nothing leaves the server.
// See PRODUCTION_READINESS.md, section B1.

const store = require("./store");
const { renderMessage } = require("./messageTemplates");
const { isEmail, canonical } = require("./contact");
const resendEmail = require("./staffEmail");

async function record({
  respondentId,
  template,
  to,
  variables,
  provider,
  status,
  body,
  error,
  providerMessageId,
}) {
  await store.insert("whatsapp_outbox", {
    respondent_id: respondentId || null,
    template,
    payload_json: JSON.stringify({
      to,
      variables,
      body,
      error,
      providerMessageId,
    }),
    provider,
    status,
  });
}

function env(name) {
  const value = process.env[name];
  return value == null ? "" : String(value).trim();
}

const WHATSAPP_TEMPLATE_ENV = {
  survey_invite: "TWILIO_WHATSAPP_SURVEY_INVITE_CONTENT_SID",
  diary_link_invite: "TWILIO_WHATSAPP_DIARY_INVITE_CONTENT_SID",
  diary_due_reminder: "TWILIO_WHATSAPP_DIARY_DUE_CONTENT_SID",
  diary_missed_reminder: "TWILIO_WHATSAPP_DIARY_MISSED_CONTENT_SID",
};

function whatsappTemplateVariables(template, variables = {}) {
  if (template === "otp_contact_verification") return { "1": String(variables.code || "") };
  if (Object.prototype.hasOwnProperty.call(WHATSAPP_TEMPLATE_ENV, template)) {
    return {
      "1": String(variables.name || "participant"),
      "2": String(variables.study || "INICIO Diary"),
      "3": String(variables.link || ""),
    };
  }
  return {};
}

class MockProvider {
  get name() {
    return "mock";
  }
  get isReal() {
    return false;
  }
  async send({ respondentId, to, template, variables, channel, contentSid, contentVariables, logBody }) {
    let body = null;
    let error = null;
    if (contentSid) {
      body = logBody || null;
    } else {
      try {
        body = renderMessage(template, variables);
      } catch (e) {
        error = e.message;
      }
    }
    await record({ respondentId, template, to, variables, provider: `mock_${channel || "message"}`, status: error ? "failed" : "simulated", body, error });
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
    const legacyChannel = (env("TWILIO_CHANNEL") || "sms").toLowerCase();
    this.smsMessagingServiceSid = env("TWILIO_SMS_MESSAGING_SERVICE_SID") || (legacyChannel === "sms" ? this.messagingServiceSid : "");
    this.whatsappMessagingServiceSid = env("TWILIO_WHATSAPP_MESSAGING_SERVICE_SID") || (legacyChannel === "whatsapp" ? this.messagingServiceSid : "");
    this.from = env("TWILIO_FROM_NUMBER");
    this.smsFrom = env("TWILIO_SMS_FROM_NUMBER") || this.from;
    this.whatsappFrom = env("TWILIO_WHATSAPP_FROM_NUMBER") || env("WHATSAPP_BOT_NUMBER") || this.from;
    this.channel = legacyChannel;
    // Meta only allows freeform WhatsApp text inside an active 24h conversation
    // window; a code sent cold (the normal case for a first-time OTP) needs a
    // pre-approved authentication template instead, or Twilio returns error
    // 63016 and the message never reaches the recipient.
    this.whatsappOtpContentSid = env("TWILIO_WHATSAPP_OTP_CONTENT_SID");
    if (this.whatsappOtpContentSid && !/^HX[0-9a-fA-F]{32}$/.test(this.whatsappOtpContentSid)) {
      throw new Error("TWILIO_WHATSAPP_OTP_CONTENT_SID must be a valid Content SID beginning with HX.");
    }
    this.whatsappTemplateSids = {};
    for (const [template, setting] of Object.entries(WHATSAPP_TEMPLATE_ENV)) {
      const sid = env(setting);
      if (sid && !/^HX[0-9a-fA-F]{32}$/.test(sid)) {
        throw new Error(`${setting} must be a valid Content SID beginning with HX.`);
      }
      if (sid) this.whatsappTemplateSids[template] = sid;
    }
    // Maps a single-select question's option count (2-10, Meta's List Picker
    // cap) to the pre-created twilio/list-picker Content SID sized for it --
    // see scripts/setupWhatsappListPickerTemplates.js. List-picker content
    // can never be Meta-approved (Twilio docs: "can't be submitted for
    // approval"), so it only works as a reply inside a session the respondent
    // already opened -- exactly how every WhatsApp diary conversation starts.
    this.whatsappListPickerSids = {};
    const listPickerRaw = env("TWILIO_WHATSAPP_LIST_PICKER_SIDS");
    if (listPickerRaw) {
      try {
        this.whatsappListPickerSids = JSON.parse(listPickerRaw);
      } catch (e) {
        throw new Error("TWILIO_WHATSAPP_LIST_PICKER_SIDS must be valid JSON mapping option count to Content SID.");
      }
    }
    for (const [name, sid] of [
      ["TWILIO_SMS_MESSAGING_SERVICE_SID", this.smsMessagingServiceSid],
      ["TWILIO_WHATSAPP_MESSAGING_SERVICE_SID", this.whatsappMessagingServiceSid],
    ]) {
      if (sid && !/^MG[0-9a-fA-F]{32}$/.test(sid)) throw new Error(`${name} must be a valid Messaging Service SID beginning with MG.`);
    }
    if (!this.smsMessagingServiceSid && !this.smsFrom && !this.whatsappMessagingServiceSid && !this.whatsappFrom) {
      throw new Error(
        "Configure at least one Twilio sender: TWILIO_SMS_FROM_NUMBER, TWILIO_WHATSAPP_FROM_NUMBER, or a channel-specific Messaging Service SID."
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

  address(number, channel = this.channel) {
    const trimmed = String(number || "").trim();
    if (channel !== "whatsapp") return trimmed.replace(/^whatsapp:/, "");
    return trimmed.startsWith("whatsapp:") ? trimmed : `whatsapp:${trimmed}`;
  }

  senderFor(channel) {
    return channel === "whatsapp"
      ? { messagingServiceSid: this.whatsappMessagingServiceSid, from: this.whatsappFrom }
      : { messagingServiceSid: this.smsMessagingServiceSid, from: this.smsFrom };
  }

  listPickerSidFor(itemCount) {
    return this.whatsappListPickerSids[String(itemCount)] || null;
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

  async send({ respondentId, to, template, variables, channel, contentSid, contentVariables, logBody }) {
    const deliveryChannel = ["sms", "whatsapp"].includes(channel) ? channel : this.channel;
    const providerName = `twilio_${deliveryChannel}`;
    const approvedContentSid = deliveryChannel === "whatsapp"
      ? (template === "otp_contact_verification" ? this.whatsappOtpContentSid : this.whatsappTemplateSids[template])
      : null;
    const effectiveContentSid = contentSid || approvedContentSid;
    let body;
    if (contentSid) body = logBody || "";
    else {
      try {
        body = renderMessage(template, variables);
      } catch (e) {
        await record({ respondentId, template, to, variables, provider: providerName, status: "failed", error: e.message });
        return { ok: false, error: e.message };
      }
    }

    if (deliveryChannel === "whatsapp" && template && (template === "otp_contact_verification" || WHATSAPP_TEMPLATE_ENV[template]) && !effectiveContentSid) {
      const setting = template === "otp_contact_verification"
        ? "TWILIO_WHATSAPP_OTP_CONTENT_SID"
        : WHATSAPP_TEMPLATE_ENV[template];
      const error = `WhatsApp delivery for ${template} requires an approved template. Configure ${setting}.`;
      await record({ respondentId, template, to, variables, provider: providerName, status: "failed", body, error });
      return { ok: false, error };
    }

    const trimmed = String(to || "").trim();
    if (!/^\+[1-9]\d{6,14}$/.test(trimmed.replace(/^whatsapp:/, ""))) {
      const error = `\"${to}\" is not in international format. Numbers must start with + and the country code (e.g. +2348012345678).`;
      await record({ respondentId, template, to, variables, provider: providerName, status: "failed", body, error });
      return { ok: false, error };
    }

    const sender = this.senderFor(deliveryChannel);
    if (!sender.messagingServiceSid && !sender.from) {
      const error = `${deliveryChannel === "whatsapp" ? "WhatsApp" : "SMS"} delivery is not configured with a sender number or Messaging Service.`;
      await record({ respondentId, template, to, variables, provider: providerName, status: "failed", body, error });
      return { ok: false, error };
    }
    const form = new URLSearchParams({ To: this.address(trimmed, deliveryChannel) });
    if (effectiveContentSid) {
      // Caller-specified content (e.g. a List Picker for a diary question) --
      // sent as a session reply -- or an approved business-initiated template.
      form.set("ContentSid", effectiveContentSid);
      form.set("ContentVariables", JSON.stringify(contentSid
        ? (contentVariables || {})
        : whatsappTemplateVariables(template, variables)));
    } else {
      form.set("Body", body);
    }
    if (sender.messagingServiceSid) form.set("MessagingServiceSid", sender.messagingServiceSid);
    else form.set("From", this.address(sender.from, deliveryChannel));

    const credentials = this.credentialsInOrder();
    let last = null;

    try {
      for (let index = 0; index < credentials.length; index += 1) {
        last = await this.requestMessage(form, credentials[index]);

        if (last.resp.ok) {
          await record({
            respondentId,
            template,
            to,
            variables,
            provider: providerName,
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

      await record({ respondentId, template, to, variables, provider: providerName, status: "failed", body, error: diagnostic });

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
      await record({ respondentId, template, to, variables, provider: providerName, status: "failed", body, error });
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
    await record({ respondentId, template, to, variables, provider: "meta_cloud_api", status: "failed", error });
    return { ok: false, error };
  }
}

async function resolveDeliveryChannel({ to, respondentId, channel }) {
  if (isEmail(to)) return "email";
  if (["sms", "whatsapp", "email"].includes(channel)) return channel;
  let respondent = respondentId ? await store.findOne("respondents", { id: respondentId }) : null;
  if (!respondent && to) {
    const contact = canonical(to);
    const matches = await store.find("respondents", { contact }, { sort: { id: -1 } });
    respondent = matches.find((item) => !item.withdrawn_at && !item.erased_at) || null;
  }
  return respondent && respondent.preferred_channel === "whatsapp" ? "whatsapp" : "sms";
}

class RoutingProvider {
  get name() {
    let phoneName;
    try { phoneName = getPhoneProvider().name; } catch (_) { phoneName = `${providerName()}_misconfigured`; }
    return `${phoneName}${resendEmail.configured() ? "+resend" : ""}`;
  }
  get isReal() {
    try { return getPhoneProvider().isReal || resendEmail.configured(); }
    catch (_) { return resendEmail.configured(); }
  }
  async send(args) {
    const channel = await resolveDeliveryChannel(args);
    if (channel !== "email") {
      try { return await getPhoneProvider().send({ ...args, channel }); }
      catch (error) {
        let body = null;
        try { body = renderMessage(args.template, args.variables); } catch (_) {}
        await record({ respondentId: args.respondentId, template: args.template, to: args.to, variables: args.variables, provider: `${providerName()}_${channel}`, status: "failed", body, error: error.message });
        return { ok: false, error: error.message };
      }
    }
    if (!resendEmail.configured()) return new MockProvider().send({ ...args, channel: "email" });
    try {
      const result = await resendEmail.sendRespondentMessage(args);
      await record({
        respondentId: args.respondentId,
        template: args.template,
        to: args.to,
        variables: args.variables,
        provider: "resend_email",
        status: "sent",
        body: result.body,
        providerMessageId: result.providerMessageId,
      });
      return result;
    } catch (error) {
      const message = error.message;
      let body = null;
      try { body = renderMessage(args.template, args.variables); } catch (_) {}
      await record({ respondentId: args.respondentId, template: args.template, to: args.to, variables: args.variables, provider: "resend_email", status: "failed", body, error: message });
      return { ok: false, error: message };
    }
  }
}

function providerName() {
  return (process.env.MESSAGING_PROVIDER || process.env.WHATSAPP_PROVIDER || "mock").toLowerCase();
}

function getPhoneProvider() {
  const name = providerName();
  if (name === "twilio") return new TwilioProvider();
  if (name === "meta_cloud_api") return new MetaCloudApiProvider();
  return new MockProvider();
}

function getProvider() {
  return new RoutingProvider();
}

function isRealMessagingConfigured(contact) {
  if (contact && isEmail(contact)) return resendEmail.configured();
  try {
    return contact ? getPhoneProvider().isReal : getProvider().isReal;
  } catch {
    return false;
  }
}

function messagingConfigError() {
  const errors = [];
  if (providerName() !== "mock") {
    try { getPhoneProvider(); } catch (error) { errors.push(error.message); }
  }
  const emailError = resendEmail.configError();
  if (emailError) errors.push(emailError);
  return errors.length ? errors.join(" ") : null;
}

// A published questionnaire version maps to one Meta-built whatsapp/flows
// Content SID. Published Flow assets are immutable, so the version is part of
// the lookup key. A study-only/default key is accepted for small pilots.
function whatsappFlowContentSid(studyId, version) {
  const single = env("TWILIO_WHATSAPP_FLOW_CONTENT_SID");
  let mapping = {};
  const raw = env("TWILIO_WHATSAPP_FLOW_CONTENT_SIDS");
  if (raw) {
    try {
      mapping = JSON.parse(raw);
    } catch (_) {
      throw new Error("TWILIO_WHATSAPP_FLOW_CONTENT_SIDS must be valid JSON.");
    }
  }
  const sid = mapping[String(studyId) + ":" + String(version)] ||
    mapping[String(studyId)] || mapping.default || single || null;
  if (sid && !/^HX[0-9a-fA-F]{32}$/.test(String(sid))) {
    throw new Error("The configured WhatsApp Flow Content SID must begin with HX and contain 32 hexadecimal characters.");
  }
  return sid ? String(sid) : null;
}

// The Content SID for a WhatsApp List Picker sized for exactly this many
// options, or null if none is configured (mock provider, or no template
// created for that count) -- callers should fall back to a plain-text prompt.
function listPickerContentSid(itemCount) {
  try {
    const provider = getPhoneProvider();
    return typeof provider.listPickerSidFor === "function" ? provider.listPickerSidFor(itemCount) : null;
  } catch (_) {
    return null;
  }
}

// Sends a WhatsApp List Picker as a session reply (never a template send --
// see the TwilioProvider constructor comment). `to` is a bare E.164 contact,
// same as every other send in this module.
async function sendWhatsAppListPicker({ respondentId, to, contentSid, variables, logBody }) {
  return getProvider().send({
    respondentId, to, channel: "whatsapp",
    template: null, variables: null,
    contentSid, contentVariables: variables, logBody,
  });
}

async function sendWhatsAppFlow({ respondentId, to, contentSid, flowToken, studyName, source }) {
  return getProvider().send({
    respondentId,
    to,
    channel: "whatsapp",
    template: "whatsapp_diary_flow",
    variables: null,
    contentSid,
    contentVariables: { "1": flowToken },
    logBody: (source === "reminder" ? "Diary reminder" : "Diary form") +
      (studyName ? " — " + studyName : ""),
  });
}

module.exports = {
  getProvider, isRealMessagingConfigured, messagingConfigError, providerName, resolveDeliveryChannel,
  listPickerContentSid, sendWhatsAppListPicker,
  whatsappFlowContentSid, sendWhatsAppFlow,
};

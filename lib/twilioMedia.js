const { persistBuffer, deleteMedia } = require("./mediaStorage");
const store = require("./store");

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const ALLOWED_TYPES = {
  photo: new Set(["image/jpeg", "image/png", "image/webp"]),
  video: new Set(["video/mp4", "video/3gpp"]),
  audio: new Set(["audio/ogg", "audio/mpeg", "audio/mp4", "audio/amr"]),
};

function trustedUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch (_) { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") return null;
  if (host === "api.twilio.com" || /^api\.[a-z0-9-]+\.[a-z0-9-]+\.twilio\.com$/.test(host)) return url;
  if (host === "media.twiliocdn.com" || host.endsWith(".media.twiliocdn.com")) return url;
  return null;
}

function credentials() {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const apiKeySid = String(process.env.TWILIO_API_KEY_SID || "").trim();
  const apiKeySecret = String(process.env.TWILIO_API_KEY_SECRET || "").trim();
  if (accountSid && authToken) return { user: accountSid, pass: authToken };
  if (apiKeySid && apiKeySecret) return { user: apiKeySid, pass: apiKeySecret };
  throw new Error("Twilio media download credentials are not configured.");
}

function normalizedType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

async function boundedBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`WhatsApp attachment exceeds the ${Math.floor(maxBytes / 1048576)} MB limit.`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`WhatsApp attachment exceeds the ${Math.floor(maxBytes / 1048576)} MB limit.`);
    chunks.push(buffer);
  }
  if (!bytes) throw new Error("Twilio returned an empty attachment.");
  return Buffer.concat(chunks, bytes);
}

async function download({ url: rawUrl, expectedType, claimedContentType, fetchImpl = fetch }) {
  const allowed = ALLOWED_TYPES[expectedType];
  if (!allowed) throw new Error("Unsupported WhatsApp media question type.");
  const claimed = normalizedType(claimedContentType);
  if (claimed && !allowed.has(claimed)) throw new Error(`Please send a ${expectedType} file for this question.`);
  const auth = credentials();
  let url = trustedUrl(rawUrl);
  if (!url) throw new Error("Twilio supplied an untrusted media URL.");
  const maxBytes = Math.max(1024, Number(process.env.WHATSAPP_MEDIA_MAX_BYTES) || DEFAULT_MAX_BYTES);

  let response;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetchImpl(url, {
      headers: { Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirects === 3) throw new Error("Twilio media redirected too many times.");
    url = trustedUrl(new URL(response.headers.get("location") || "", url).toString());
    if (!url) throw new Error("Twilio media redirected to an untrusted host.");
  }
  if (!response || !response.ok) throw new Error(`Twilio media download failed with HTTP ${response ? response.status : "unknown"}.`);
  const actual = normalizedType(response.headers.get("content-type")) || claimed;
  if (!allowed.has(actual)) throw new Error(`Please send a supported ${expectedType} file.`);
  return { buffer: await boundedBody(response, maxBytes), mimetype: actual };
}

async function ingest({ respondentId, questionId, mediaType, url, contentType, fetchImpl }) {
  const downloaded = await download({ url, expectedType: mediaType, claimedContentType: contentType, fetchImpl });
  const filePath = await persistBuffer(downloaded.buffer, downloaded.mimetype);
  try {
    const { id } = await store.insert("staged_media", {
      respondent_id: respondentId,
      question_id: questionId,
      media_type: mediaType,
      mimetype: downloaded.mimetype,
      file_path: filePath,
      source: "whatsapp",
    });
    return store.findOne("staged_media", { id });
  } catch (error) {
    await deleteMedia(filePath).catch(() => {});
    throw error;
  }
}

module.exports = { ingest, download, trustedUrl, normalizedType, ALLOWED_TYPES };

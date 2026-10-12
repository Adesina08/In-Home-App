// Self-hosted over-the-air updates for the Android app (Expo Updates protocol
// v1). The Build Android APK workflow runs `expo export` and deploys the
// result to ota/ with expoConfig.json and build.json; apps whose runtime
// version matches get the bundle on next launch. Other runtimes get "no
// update" and are offered the new APK instead (expo-mobile/src/appUpdate.ts).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mime = require("mime-types");

const OTA_DIR = process.env.OTA_DIR || path.join(__dirname, "..", "ota");

let cached;
function loadRelease(dir = OTA_DIR) {
  if (cached && cached.dir === dir) return cached.release;
  let release = null;
  try {
    const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const build = read("build.json");
    const files = read("metadata.json").fileMetadata.android;
    const describe = (relative, contentType, fileExtension) => {
      const bytes = fs.readFileSync(path.join(dir, relative));
      return {
        path: relative,
        hash: crypto.createHash("sha256").update(bytes).digest("base64url"),
        key: crypto.createHash("md5").update(bytes).digest("hex"),
        contentType,
        fileExtension,
      };
    };
    const launchAsset = describe(files.bundle, "application/javascript", ".bundle");
    const assets = files.assets.map((a) => describe(a.path, mime.lookup(a.ext) || "application/octet-stream", `.${a.ext}`));
    // The update id must change whenever any file does, and stay put otherwise.
    const digest = crypto.createHash("sha256").update([launchAsset, ...assets].map((a) => a.hash).join()).digest("hex");
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    release = { id, runtimeVersion: build.runtimeVersion, createdAt: build.createdAt, launchAsset, assets, expoClient: read("expoConfig.json") };
  } catch {
    // No export deployed (local dev, or a deploy without the OTA artifact).
  }
  cached = { dir, release };
  return release;
}

function multipart(res, name, body) {
  const boundary = `ota-${crypto.randomBytes(12).toString("hex")}`;
  res.set("content-type", `multipart/mixed; boundary=${boundary}`);
  res.send(`--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${JSON.stringify(body)}\r\n--${boundary}--\r\n`);
}

function manifestHandler({ baseUrl, dir } = {}) {
  return (req, res) => {
    res.set({ "expo-protocol-version": "1", "expo-sfv-version": "0", "cache-control": "private, max-age=0" });
    if (req.get("expo-platform") !== "android") return res.status(400).json({ error: "Only Android updates are published." });
    const release = loadRelease(dir);
    const runtime = req.get("expo-runtime-version");
    if (!release || runtime !== release.runtimeVersion || req.get("expo-current-update-id") === release.id) {
      return multipart(res, "directive", { type: "noUpdateAvailable" });
    }
    const base = `${baseUrl ? baseUrl(req) : `${req.protocol}://${req.get("host")}`}/ota/files/`;
    const asset = ({ path: p, ...rest }) => ({ ...rest, url: base + p });
    multipart(res, "manifest", {
      id: release.id,
      createdAt: release.createdAt,
      runtimeVersion: release.runtimeVersion,
      launchAsset: asset(release.launchAsset),
      assets: release.assets.map(asset),
      metadata: {},
      extra: { expoClient: release.expoClient },
    });
  };
}

module.exports = { OTA_DIR, loadRelease, manifestHandler };

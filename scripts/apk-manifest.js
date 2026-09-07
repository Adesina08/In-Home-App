// Sidecar metadata identifies the exact native source served by the web download.
const fs = require('node:fs');
const crypto = require('node:crypto');
const [apk, destination] = process.argv.slice(2);
if (!apk || !destination) throw new Error('Usage: node scripts/apk-manifest.js APK MANIFEST');
const config = require('../expo-mobile/app.json').expo;
const bytes = fs.readFileSync(apk);
const manifest = { app: config.name, package: config.android.package, source: 'expo-mobile', version: process.env.ANDROID_VERSION_NAME || config.version,
  versionCode: Number(process.env.ANDROID_VERSION_CODE || config.android.versionCode), revision: process.env.GITHUB_SHA || 'local', builtAt: new Date().toISOString(),
  bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), features: ['standard-entry', 'video-entry', 'in-camera-teleprompter', 'offline-submission-queue'] };
fs.writeFileSync(destination, JSON.stringify(manifest, null, 2) + '\n');

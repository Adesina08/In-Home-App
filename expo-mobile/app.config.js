const crypto = require('node:crypto');
const pkg = require('./package.json');

// Over-the-air JavaScript updates (served by lib/otaUpdates.js) only reach
// installs whose native code matches. The runtime version hashes everything
// that shapes the native build -- dependencies, native config, config plugins
// -- so adding a module or permission yields a new runtime that needs a new
// APK (offered by src/appUpdate.ts), while JS-only changes keep it.
// Hashes app.json itself rather than the config Expo passes in, so the build,
// `expo export` and scripts/apk-manifest.js all compute the same value.
function runtimeVersion() {
  const fs = require('node:fs');
  const { android: { versionCode, ...android } = {}, plugins, scheme } = JSON.parse(fs.readFileSync(`${__dirname}/app.json`, 'utf8')).expo;
  const pluginSources = fs.readdirSync(`${__dirname}/plugins`).sort().map(f => f + fs.readFileSync(`${__dirname}/plugins/${f}`, 'utf8'));
  const native = JSON.stringify({ dependencies: pkg.dependencies, android, plugins, pluginSources, scheme });
  return `native-${crypto.createHash('sha256').update(native).digest('hex').slice(0, 12)}`;
}

module.exports = ({ config }) => {
  const versionCode = Number(process.env.ANDROID_VERSION_CODE || config.android.versionCode);
  if (!Number.isInteger(versionCode) || versionCode <= 1 || versionCode > 2100000000) throw new Error('ANDROID_VERSION_CODE must be an integer above the legacy APK version (1).');
  const apiUrl = (process.env.EXPO_PUBLIC_API_URL || config.extra.apiUrl).replace(/\/$/, '');
  return { ...config, version: process.env.ANDROID_VERSION_NAME || config.version,
    android: { ...config.android, versionCode },
    runtimeVersion: runtimeVersion(),
    // Check on every launch without waiting: a new update downloads in the
    // background and takes over on the next cold start.
    updates: { url: `${apiUrl}/ota/manifest`, enabled: true, checkAutomatically: 'ON_LOAD', fallbackToCacheTimeout: 0 },
    extra: { ...config.extra, apiUrl, sourceRevision: process.env.GITHUB_SHA || 'local' } };
};

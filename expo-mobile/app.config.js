module.exports = ({ config }) => {
  const versionCode = Number(process.env.ANDROID_VERSION_CODE || config.android.versionCode);
  if (!Number.isInteger(versionCode) || versionCode <= 1 || versionCode > 2100000000) throw new Error('ANDROID_VERSION_CODE must be an integer above the legacy APK version (1).');
  return { ...config, version: process.env.ANDROID_VERSION_NAME || config.version,
    android: { ...config.android, versionCode },
    extra: { ...config.extra, apiUrl: process.env.EXPO_PUBLIC_API_URL || config.extra.apiUrl, sourceRevision: process.env.GITHUB_SHA || 'local' } };
};

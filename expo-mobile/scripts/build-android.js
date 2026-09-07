const { spawnSync } = require('node:child_process');
const path = require('node:path');
process.chdir(path.join(__dirname, '..'));
for (const key of ['ANDROID_KEYSTORE_FILE', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS']) {
  if (!process.env[key]) throw new Error(`${key} is required for a local signed build. Alternatively run the Build Android APK workflow in GitHub Actions.`);
}
function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: '1' } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install']);
run('./gradlew', [process.argv[2] === 'aab' ? ':app:bundleRelease' : ':app:assembleRelease', '--no-daemon', '--max-workers=2'], path.join(process.cwd(), 'android'));

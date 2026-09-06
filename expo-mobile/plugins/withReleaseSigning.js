const { withAppBuildGradle } = require('expo/config-plugins');
module.exports = config => withAppBuildGradle(config, config => {
  const line = 'apply from: new File(project.projectDir, "../../scripts/release-signing.gradle")';
  if (!config.modResults.contents.includes(line)) config.modResults.contents += `\n${line}\n`;
  return config;
});

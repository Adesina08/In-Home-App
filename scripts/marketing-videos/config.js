// Shared paths for the marketing video tooling.
const path = require('path');

const APP = path.resolve(__dirname, '..', '..');
const WORK = path.join(__dirname, '.work');

module.exports = {
  APP,
  WORK,
  BASE: 'http://localhost:3100',
  FFMPEG: require(path.join(APP, 'node_modules', 'ffmpeg-static')),
  CHROME: path.join(process.env.HOME, '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'),
  UPLOADS: path.join(WORK, 'uploads'),
  DB: path.join(WORK, 'demo.localdb.json'),
};

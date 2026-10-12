const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { manifestHandler } = require('../lib/otaUpdates');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-'));
  const write = (file, body) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), body); };
  write('_expo/static/js/android/index-abc.hbc', 'bundle');
  write('assets/f00', 'png-bytes');
  write('metadata.json', JSON.stringify({ version: 0, fileMetadata: { android: { bundle: '_expo/static/js/android/index-abc.hbc', assets: [{ path: 'assets/f00', ext: 'png' }] } } }));
  write('build.json', JSON.stringify({ runtimeVersion: 'native-1', createdAt: '2026-10-12T00:00:00.000Z' }));
  write('expoConfig.json', JSON.stringify({ name: 'INICIO Diary' }));
  return dir;
}

async function request(dir, headers) {
  const app = express();
  app.get('/ota/manifest', manifestHandler({ dir }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/ota/manifest`, { headers });
    const text = await res.text();
    const json = text.match(/\r\n\r\n(\{.*\})\r\n--/s);
    return { status: res.status, headers: res.headers, name: (text.match(/name="(\w+)"/) || [])[1], body: json && JSON.parse(json[1]) };
  } finally { server.close(); }
}

const android = { 'expo-platform': 'android', 'expo-protocol-version': '1' };

test('serves the bundle and assets to a matching runtime', async () => {
  const res = await request(fixture(), { ...android, 'expo-runtime-version': 'native-1' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('expo-protocol-version'), '1');
  assert.match(res.headers.get('content-type'), /^multipart\/mixed; boundary=/);
  assert.equal(res.name, 'manifest');
  assert.equal(res.body.runtimeVersion, 'native-1');
  assert.match(res.body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(res.body.launchAsset.url, /\/ota\/files\/_expo\/static\/js\/android\/index-abc\.hbc$/);
  assert.equal(res.body.launchAsset.hash, require('node:crypto').createHash('sha256').update('bundle').digest('base64url'));
  assert.deepEqual(res.body.assets.map((a) => [a.contentType, a.fileExtension]), [['image/png', '.png']]);
  assert.deepEqual(res.body.extra.expoClient, { name: 'INICIO Diary' });
});

test('other runtimes and up-to-date apps are told there is no update', async () => {
  const dir = fixture();
  const other = await request(dir, { ...android, 'expo-runtime-version': 'native-0' });
  assert.equal(other.name, 'directive');
  assert.deepEqual(other.body, { type: 'noUpdateAvailable' });
  const { body } = await request(dir, { ...android, 'expo-runtime-version': 'native-1' });
  const current = await request(dir, { ...android, 'expo-runtime-version': 'native-1', 'expo-current-update-id': body.id });
  assert.equal(current.name, 'directive');
});

test('no deployed export means no update', async () => {
  const res = await request(fs.mkdtempSync(path.join(os.tmpdir(), 'ota-empty-')), { ...android, 'expo-runtime-version': 'native-1' });
  assert.deepEqual(res.body, { type: 'noUpdateAvailable' });
});

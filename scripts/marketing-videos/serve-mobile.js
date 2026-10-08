// Serves the web export of the Expo mobile app (.work/mobile-web) on :8090 for recording.
// Build it with: cd ../../expo-mobile && EXPO_PUBLIC_API_URL=http://localhost:3100 npx expo export --platform web --output-dir ../scripts/marketing-videos/.work/mobile-web
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '.work', 'mobile-web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const clean = path.normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(ROOT, clean);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html'); // single-page app
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(8090, () => console.log('Mobile app (web build) on http://localhost:8090'));

// Stock media from Pixabay (Content License: free for commercial use, no attribution required).
//   node stock.js search   -> .work/stock/candidates.json + labelled contact sheets to review
//   node stock.js get <id> [<id> ...] -> download chosen items into .work/stock/picked/
// Search results are cached, per the Pixabay API terms; only chosen items are downloaded.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { APP, WORK, CHROME } = require('./config');

const KEY = require(path.join(APP, 'node_modules', 'dotenv')).parse(fs.readFileSync(path.join(APP, '.env'))).PIXABAY_API_KEY;
const DIR = path.join(WORK, 'stock');
const PHOTO_QUERIES = ['african family breakfast', 'african woman drinking', 'glass of drink on table', 'family dinner africa', 'lunch break drink office', 'friends drinking party africa', 'cold drink glass', 'breakfast bread tea table', 'black woman drinking', 'black man drinking', 'black family meal', 'nigerian food', 'jollof rice', 'woman kitchen breakfast black', 'iced drink glass table', 'dark soda glass ice', 'black friends eating', 'black woman smartphone'];
const VIDEO_QUERIES = ['pouring drink glass', 'drinking from glass', 'african family eating', 'breakfast table', 'woman drinking at home', 'friends toast drinks', 'black woman drinking', 'black man drinking', 'black family eating', 'african woman cooking', 'pouring soda glass ice', 'black woman phone', 'nigeria', 'family dinner table'];

async function api(kind, q) {
  const cache = path.join(DIR, 'cache', `${kind}-${q.replace(/\W+/g, '_')}.json`);
  if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < 24 * 3600e3) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const url = `https://pixabay.com/api/${kind === 'video' ? 'videos/' : ''}?key=${KEY}&q=${encodeURIComponent(q)}&safesearch=true&per_page=30${kind === 'photo' ? '&image_type=photo' : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay ${res.status}: ${await res.text()}`);
  const data = await res.json();
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(data));
  return data;
}

async function search() {
  const seen = new Map();
  for (const [kind, queries] of [['photo', PHOTO_QUERIES], ['video', VIDEO_QUERIES]]) {
    for (const q of queries) {
      for (const h of (await api(kind, q)).hits) {
        if (seen.has(h.id)) continue;
        seen.set(h.id, {
          id: h.id, kind, query: q, tags: h.tags, page: h.pageURL, user: h.user,
          thumb: kind === 'photo' ? h.webformatURL : h.videos.tiny.thumbnail || h.videos.small.thumbnail,
          file: kind === 'photo' ? h.largeImageURL : (h.videos.medium.url || h.videos.small.url),
          duration: h.duration || null, width: kind === 'photo' ? h.imageWidth : h.videos.medium.width, height: kind === 'photo' ? h.imageHeight : h.videos.medium.height,
        });
      }
    }
  }
  const all = [...seen.values()];
  fs.writeFileSync(path.join(DIR, 'candidates.json'), JSON.stringify(all, null, 2));
  // Contact sheets: 30 per sheet, each tile labelled with its id, for a visual brand/realism check.
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  for (const kind of ['photo', 'video']) {
    const items = all.filter((x) => x.kind === kind);
    for (let s = 0; s * 30 < items.length; s++) {
      const tiles = items.slice(s * 30, s * 30 + 30).map((x) => `<figure><img src="${x.thumb}"><figcaption>${x.id}${x.duration ? ` · ${x.duration}s` : ''}</figcaption></figure>`).join('');
      await page.setContent(`<html><body style="margin:0;background:#111;font:600 15px Arial;color:#fff;display:grid;grid-template-columns:repeat(6,1fr);gap:4px">
        <style>figure{margin:0;position:relative;height:196px;overflow:hidden}img{width:100%;height:100%;object-fit:cover}figcaption{position:absolute;left:0;top:0;background:#000c;padding:3px 6px}</style>${tiles}</body></html>`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: path.join(DIR, `sheet-${kind}-${s + 1}.png`), fullPage: true });
    }
  }
  await browser.close();
  console.log(`${all.filter((x) => x.kind === 'photo').length} photos, ${all.filter((x) => x.kind === 'video').length} videos -> ${DIR}`);
}

async function get(ids) {
  const all = JSON.parse(fs.readFileSync(path.join(DIR, 'candidates.json'), 'utf8'));
  const out = path.join(DIR, 'picked');
  fs.mkdirSync(out, { recursive: true });
  for (const id of ids.map(Number)) {
    const item = all.find((x) => x.id === id);
    if (!item) throw new Error(`No candidate ${id}`);
    const file = path.join(out, `${item.kind}-${id}${item.kind === 'photo' ? '.jpg' : '.mp4'}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(await (await fetch(item.file)).arrayBuffer()));
    console.log(`${path.basename(file)}  ${item.tags}  (${item.page})`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
(cmd === 'get' ? get(rest) : search()).catch((e) => { console.error(e.message); process.exit(1); });

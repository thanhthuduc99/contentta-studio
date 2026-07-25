#!/usr/bin/env node
// pixabay-broll.mjs — auto tải b-roll free từ Pixabay (CC0) theo mapping keyword.
//
// Pixabay video API: https://pixabay.com/api/videos/?key=KEY&q=...
// Trả hits[].videos.{large,medium,small,tiny}.{url,width,height}. License CC0 (free thương mại).
//
// Usage:
//   node pixabay-broll.mjs --key <KEY> --out assets/broll --map broll-map.json
//   broll-map.json = [{ "slug": "coding", "q": "programming code screen" }, ...]
//   (key cũng đọc được từ PIXABAY_API_KEY trong .env nếu bỏ --key)
//
// Tải file medium (cân chất lượng/dung lượng) -> <out>/<slug>.mp4.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const args = process.argv.slice(2);
const getArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const outDir = getArg('--out') || 'assets/broll';
const mapPath = getArg('--map');
let key = getArg('--key');
if (!key) {
  let dir = process.cwd();
  for (let i = 0; i < 6 && !key; i++) {
    const p = join(dir, '.env');
    if (existsSync(p)) { const m = readFileSync(p, 'utf8').match(/PIXABAY_API_KEY\s*=\s*(.+)/); if (m) key = m[1].trim(); }
    dir = dirname(dir);
  }
}
if (!key || !mapPath) { console.error('Usage: node pixabay-broll.mjs --key <KEY> --out <dir> --map <map.json>'); process.exit(1); }

const map = JSON.parse(readFileSync(mapPath, 'utf8'));
mkdirSync(outDir, { recursive: true });

function pickFile(videos) {
  // ưu tiên medium -> large -> small -> tiny, miễn có url
  for (const k of ['medium', 'large', 'small', 'tiny']) {
    if (videos[k] && videos[k].url) return videos[k];
  }
  return null;
}

const results = [];
for (const item of map) {
  const url = `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(item.q)}&per_page=8&safesearch=true`;
  try {
    const r = await fetch(url);
    if (!r.ok) { console.error(`[${item.slug}] search HTTP ${r.status}`); results.push({ ...item, ok: false }); continue; }
    const j = await r.json();
    const hits = j.hits || [];
    if (!hits.length) { console.error(`[${item.slug}] no hits for "${item.q}"`); results.push({ ...item, ok: false }); continue; }
    const chosen = hits[0];
    const vf = pickFile(chosen.videos);
    if (!vf) { console.error(`[${item.slug}] no video file`); results.push({ ...item, ok: false }); continue; }
    const buf = Buffer.from(await (await fetch(vf.url)).arrayBuffer());
    const dest = join(outDir, `${item.slug}.mp4`);
    writeFileSync(dest, buf);
    console.error(`[${item.slug}] "${item.q}" -> ${dest} (${vf.width}x${vf.height}, ${(buf.length / 1e6).toFixed(1)}MB, id ${chosen.id})`);
    results.push({ ...item, ok: true, file: dest, w: vf.width, h: vf.height, pageURL: chosen.pageURL });
  } catch (e) {
    console.error(`[${item.slug}] ERROR ${e.message}`); results.push({ ...item, ok: false });
  }
}
writeFileSync(join(outDir, '_broll-manifest.json'), JSON.stringify(results, null, 2));
console.log(`Done: ${results.filter((r) => r.ok).length}/${map.length} downloaded -> ${outDir}`);

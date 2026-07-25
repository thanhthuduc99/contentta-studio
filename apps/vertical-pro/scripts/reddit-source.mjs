#!/usr/bin/env node
// reddit-source.mjs — tải ẢNH hoặc VIDEO từ Reddit (redvid.io) → source cho scene → cut-sources.
// Usage: node reddit-source.mjs <projectDir> <sceneIndex> <url>
//   Nhận: reddit.com/.../comments/…, redd.it/…, v.redd.it/…, i.redd.it/xxx.jpg, hoặc link redvid.io bọc.
//   Ảnh  -> fetch trực tiếp (kèm User-Agent, Reddit chặn UA rỗng).
//   Video-> python -m yt_dlp (tự gộp video+audio v.redd.it). yt-dlp fail (bài ảnh) -> đọc <url>.json lấy ảnh.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [projDir, sceneArg, rawUrl] = process.argv.slice(2);
const idx = parseInt(sceneArg, 10);
if (!projDir || !idx || !rawUrl) { console.error('Usage: node reddit-source.mjs <projectDir> <sceneIndex> <url>'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) contentta-studio/1.0';
const decode = (s) => String(s).replace(/&amp;/g, '&');
const IMG_RE = /\.(jpe?g|png|gif|webp)$/i;

// redvid.io bọc link reddit -> rút link reddit thật (param ?url= hoặc regex trong chuỗi)
function normUrl(u) {
  u = String(u).trim();
  if (/redvid\.io/i.test(u)) {
    try { const q = new URL(u).searchParams.get('url'); if (q) return q; } catch {}
    const m = u.match(/https?:\/\/[^\s]*?(?:reddit\.com|redd\.it)[^\s]*/i);
    if (m) return m[0];
  }
  return u;
}
const url = normUrl(rawUrl);

const id = 'scene-' + String(idx).padStart(2, '0');
const srcDir = join(projDir, 'assets', 'src');
mkdirSync(srcDir, { recursive: true });
for (const f of (existsSync(srcDir) ? readdirSync(srcDir) : [])) if (f.startsWith(id + '.')) { try { rmSync(join(srcDir, f)); } catch {} }

async function downloadImage(imgUrl) {
  const clean = imgUrl.split('?')[0];
  const m = clean.match(IMG_RE);
  const ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  console.log(`Tải ảnh Reddit → ${id}.${ext}`);
  const resp = await fetch(imgUrl, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`fetch ảnh ${resp.status}`);
  writeFileSync(join(srcDir, `${id}.${ext}`), Buffer.from(await resp.arrayBuffer()));
}

function tryVideo() {
  console.log('Thử tải video Reddit (yt-dlp)…');
  execFileSync('python', ['-m', 'yt_dlp',
    '-f', 'bv*+ba/b', '--no-playlist', '--no-warnings', '--no-part',
    '-o', join(srcDir, id + '.%(ext)s'), url], { stdio: 'inherit', timeout: 180000 });
  return (existsSync(srcDir) ? readdirSync(srcDir) : []).some((f) => f.startsWith(id + '.'));
}

// đọc <url>.json lấy ảnh (bài ảnh đơn / gallery / preview)
async function imageFromJson() {
  const jurl = url.split('?')[0].replace(/\/$/, '') + '.json';
  const resp = await fetch(jurl, { headers: { 'User-Agent': UA } });
  if (resp.status === 403 || resp.status === 429) throw new Error('Reddit chặn API từ server — dán LINK ẢNH trực tiếp (chuột phải ảnh → copy image address, dạng i.redd.it/…jpg) hoặc link VIDEO');
  if (!resp.ok) throw new Error(`reddit json ${resp.status}`);
  const j = await resp.json();
  const post = j?.[0]?.data?.children?.[0]?.data;
  if (!post) throw new Error('không đọc được bài Reddit');
  let u = post.url_overridden_by_dest || post.url;
  if (u && IMG_RE.test(u.split('?')[0])) return u;
  if (post.is_gallery && post.media_metadata) {
    const first = Object.values(post.media_metadata)[0];
    if (first?.s?.u) return decode(first.s.u);
    if (first?.s?.gif) return decode(first.s.gif);
  }
  const prev = post.preview?.images?.[0]?.source?.url;
  if (prev) return decode(prev);
  throw new Error('không tìm thấy ảnh/video trong bài Reddit');
}

const clean = url.split('?')[0];
try {
  if (/i\.redd\.it/i.test(url) || IMG_RE.test(clean)) {
    await downloadImage(url);                       // ảnh trực tiếp
  } else {
    let ok = false;
    try { ok = tryVideo(); } catch { ok = false; }  // thử video trước
    if (!ok) await downloadImage(await imageFromJson());  // fallback: ảnh từ JSON
  }
} catch (e) {
  console.error('REDDIT_FAIL: ' + e.message);
  process.exit(1);
}

console.log('Cắt + crop theo scene…');
execFileSync('node', [join(__dirname, 'cut-sources.mjs'), projDir, String(idx)], { stdio: 'inherit' });
console.log('REDDIT_DONE');

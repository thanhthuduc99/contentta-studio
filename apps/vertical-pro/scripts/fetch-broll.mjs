#!/usr/bin/env node
// fetch-broll.mjs — đọc broll-shotlist.json, TỰ TẠO clip video cho từng shot -> assets/broll/scene-NN.mp4.
//   screencap -> Playwright quay màn hình cuộn trang URL (đã có lib playwright ở node_modules root)
//   montage   -> ffmpeg PAN ngang qua bộ ảnh trong shot.src (>=2 ảnh: pan; 1 ảnh: ken-burns zoom)
//   stock     -> wrap pixabay-broll.mjs (cần PIXABAY_API_KEY trong .env)
// Idempotent: target đã tồn tại -> skip. Mọi clip ép 1080×1920, đúng dur scene.
// Usage: node fetch-broll.mjs <broll-shotlist.json>   (chạy TỪ TRONG folder project)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [shotPath] = process.argv.slice(2);
if (!shotPath) { console.error('Usage: node fetch-broll.mjs <broll-shotlist.json>  (từ trong folder project)'); process.exit(1); }
const PROJ = process.cwd();
const W = 1080, H = 1920, FPS = 30;
const ff = (a) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...a], { cwd: PROJ });

const { shots } = JSON.parse(readFileSync(shotPath, 'utf8'));
mkdirSync(join(PROJ, 'assets/broll'), { recursive: true });

// cover-scale 1 ảnh -> 1080×1920
const COVER = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;

function montage(shot) {
  const srcDir = join(PROJ, shot.src);
  if (!existsSync(srcDir)) return `skip (chưa có folder ${shot.src})`;
  const imgs = readdirSync(srcDir).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort().map((f) => join(srcDir, f));
  if (!imgs.length) return `skip (folder ${shot.src} rỗng)`;
  const dur = Math.max(1, shot.dur);
  const out = join(PROJ, shot.target);
  if (imgs.length === 1) {
    // 1 ảnh -> ken-burns zoom nhẹ (giống Nate khi chỉ 1 output)
    ff(['-loop', '1', '-i', imgs[0], '-t', String(dur),
      '-vf', `${COVER},zoompan=z='min(1.0+0.12*on/(${FPS}*${dur}),1.12)':d=${Math.round(FPS * dur)}:s=${W}x${H}:fps=${FPS}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), out]);
    return `ken-burns 1 ảnh -> ${shot.target}`;
  }
  // >=2 ảnh -> tile ngang thành dải rộng rồi PAN trái->phải (cú 16.2→16.6 của Nate)
  const wide = join(PROJ, 'assets/broll', `_wide-${shot.i}.png`);
  const ins = imgs.flatMap((p) => ['-i', p]);
  const chain = imgs.map((_, i) => `[${i}:v]${COVER}[s${i}]`).join(';');
  const stack = imgs.map((_, i) => `[s${i}]`).join('') + `hstack=inputs=${imgs.length}[w]`;
  ff([...ins, '-filter_complex', `${chain};${stack}`, '-map', '[w]', '-frames:v', '1', wide]);
  const totalW = W * imgs.length;
  ff(['-loop', '1', '-i', wide, '-t', String(dur),
    '-vf', `crop=${W}:${H}:x='(${totalW}-${W})*min(t/${dur}\\,1)':y=0,fps=${FPS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), out]);
  rmSync(wide, { force: true });
  return `pan ${imgs.length} ảnh -> ${shot.target}`;
}

const HOST_DEPTH = {};   // mỗi lần quay lại CÙNG host -> cuộn sâu hơn (đa dạng giữa các scene)
async function screencap(shot) {
  if (!shot.url) return 'skip (chưa có url)';
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { return 'skip (playwright lib lỗi)'; }
  let host = 'web'; try { host = new URL(shot.url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.]/gi, '_'); } catch {}
  const depth = HOST_DEPTH[host] || 0; HOST_DEPTH[host] = depth + 1;
  const preScroll = 300 + depth * 480;                   // scene github sau lộ đoạn README sâu hơn
  const dur = Math.max(1.5, shot.dur);
  const LEADIN = 3.0;                                     // giây bỏ đầu (trang đang load/trắng; site client-render cần lâu hơn)
  const recDir = join(PROJ, 'assets/broll', `_rec-${shot.i}`);
  mkdirSync(recDir, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch();
    // render kiểu MOBILE -> đặc nội dung, ít khoảng trắng (giống IG/tool trên phone)
    const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, recordVideo: { dir: recDir, size: { width: 440, height: 956 } } });
    const page = await ctx.newPage();
    await page.goto(shot.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await page.waitForLoadState('networkidle', { timeout: 7000 }); } catch {}
    await page.waitForTimeout((LEADIN - 0.8) * 1000);      // chờ paint (phần này bị cắt bỏ)
    const scrollBy = (px) => page.evaluate((p) => window.scrollBy(0, p), px);  // scrollBy chắc hơn mouse.wheel
    const incN = Math.max(2, Math.round(preScroll / 280)); // cuộn tới điểm bắt đầu (sâu dần theo scene)
    for (let k = 0; k < incN; k++) { await scrollBy(Math.round(preScroll / incN)); await page.waitForTimeout(110); }
    await page.waitForTimeout(300);
    const steps = Math.max(4, Math.round(dur * 2));        // cuộn từ từ suốt thời lượng
    for (let i = 0; i < steps; i++) { await scrollBy(300); await page.waitForTimeout((dur * 1000) / steps); }
    await ctx.close();                                     // flush video
    await browser.close();
  } catch (e) { try { await browser?.close(); } catch {} return `skip (lỗi quay: ${String(e.message || e).slice(0, 60)})`; }
  const webm = readdirSync(recDir).filter((f) => f.endsWith('.webm')).map((f) => join(recDir, f))[0];
  if (!webm) return 'skip (không có webm)';
  ff(['-ss', String(LEADIN), '-i', webm, '-t', String(shot.dur), '-vf', `${COVER},fps=${FPS}`, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(PROJ, shot.target)]);
  // GIỮ source: convert bản quay FULL (chưa trim) -> assets/broll/captured/ để tái dùng
  const capDir = join(PROJ, 'assets/broll/captured'); mkdirSync(capDir, { recursive: true });
  const cap = join(capDir, `scene-${String(shot.i).padStart(2, '0')}-${host}.mp4`);
  try { ff(['-i', webm, '-vf', `${COVER},fps=${FPS}`, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', cap]); } catch {}
  rmSync(recDir, { recursive: true, force: true });
  return `quay cuộn ${shot.url} -> ${shot.target} (+source captured/)`;
}

function stock(shot) {
  const map = join(PROJ, 'assets/broll', `_map-${shot.i}.json`);
  const slug = `scene-${String(shot.i).padStart(2, '0')}`;
  writeFileSync(map, JSON.stringify([{ slug, q: shot.query || 'technology' }]));
  try {
    execFileSync('node', [join(__dirname, '..', '..', '..', 'contentta-shorts-skill', 'scripts', 'pixabay-broll.mjs'), '--out', 'assets/broll', '--map', map], { cwd: PROJ, stdio: 'inherit' });
  } catch (e) { rmSync(map, { force: true }); return `skip (pixabay lỗi: ${String(e.message || e).slice(0, 50)})`; }
  rmSync(map, { force: true });
  const got = join(PROJ, 'assets/broll', `${slug}.mp4`);
  if (existsSync(got) && got !== join(PROJ, shot.target)) renameSync(got, join(PROJ, shot.target));
  // ép kích thước + dur
  if (existsSync(join(PROJ, shot.target))) {
    const tmp = join(PROJ, shot.target + '.tmp.mp4');
    ff(['-i', shot.target, '-t', String(shot.dur), '-vf', `${COVER},fps=${FPS}`, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', tmp]);
    renameSync(tmp, join(PROJ, shot.target));
    return `pixabay -> ${shot.target}`;
  }
  return 'skip (pixabay không trả video)';
}

let done = 0;
for (const shot of shots) {
  const out = join(PROJ, shot.target);
  const tag = `#${shot.i} ${shot.kind}`;
  if (shot.kind === 'none' || shot.kind === 'caption') { console.log(`${tag}: bỏ qua (builder lo)`); continue; }
  if (existsSync(out)) { console.log(`${tag}: đã có ${shot.target} (skip)`); done++; continue; }
  let msg;
  try {
    if (shot.kind === 'montage') msg = montage(shot);
    else if (shot.kind === 'screencap') msg = await screencap(shot);
    else if (shot.kind === 'stock') msg = stock(shot);
    else msg = 'kind lạ';
  } catch (e) { msg = `LỖI: ${String(e.message || e).slice(0, 80)}`; }
  if (existsSync(out)) done++;
  console.log(`${tag}: ${msg}`);
}
console.log(`\nfetch-broll xong: ${done}/${shots.filter((s) => s.kind !== 'none' && s.kind !== 'caption').length} clip sẵn sàng trong assets/broll/`);

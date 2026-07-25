#!/usr/bin/env node
// cut-sources.mjs — cắt source user kéo-thả (assets/src/scene-NN.*) thành b-roll khớp scene.
//   SPLIT (type1): luôn cover-crop 1080×960 (zoom vô). Ảnh → zoom-in.
//   FULL  (type2): áp bset {fit,scale,pos,bg,round}:
//     - nguồn phủ kín khung (dọc/scale lớn) -> cover-crop 1080×1920, không bg/bo góc.
//     - nguồn KHÔNG phủ kín (ngang/vuông/scale nhỏ) -> nền video trắng|đen loop + b-roll fit + bo góc + đặt 1 trong 9 vị trí.
//   Ảnh: có hiệu ứng zoom-in nhẹ (thấy chuyển động).
// Usage: node cut-sources.mjs <projectDir> [sceneIndex]

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const projDir = process.argv[2];
const only = process.argv[3] ? parseInt(process.argv[3], 10) : null;
if (!projDir) { console.error('Usage: node cut-sources.mjs <projectDir> [sceneIndex]'); process.exit(1); }
const plan = JSON.parse(readFileSync(join(projDir, 'plan.json'), 'utf8'));
let ZOOM = false; // zoom nhẹ cho ảnh — settings.zoom (mặc định TẮT)
try { ZOOM = JSON.parse(readFileSync(join(projDir, 'settings.json'), 'utf8')).zoom === true; } catch {}
const srcDir = join(projDir, 'assets', 'src');
const outDir = join(projDir, 'assets', 'broll');
const prevDir = join(projDir, 'previews');
const maskDir = join(outDir, '_masks');
mkdirSync(outDir, { recursive: true });
mkdirSync(prevDir, { recursive: true });
mkdirSync(maskDir, { recursive: true });
const srcFiles = existsSync(srcDir) ? readdirSync(srcDir) : [];

const W = 1080, H = 1920, HALF = 960, M = 40, R = 44;
// nền trắng/đen bundled trong app (apps/vertical-pro/background/)
const BGDIR = join(__dirname, '..', 'background');
const BG = {
  white: join(BGDIR, 'white.mp4'),
  black: join(BGDIR, 'black.mp4'),
};
const ff = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
const isImg = (f) => /\.(png|jpe?g|webp)$/i.test(f);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function probeWH(p) {
  try { const o = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', p]).toString().trim().split('\n')[0]; const [w, h] = o.split(',').map(Number); if (w && h) return { w, h }; } catch {}
  return { w: 1920, h: 1080 };
}
// mask bo góc (cache theo kích thước)
function mask(w, h) {
  const out = join(maskDir, `r${w}x${h}.png`);
  if (existsSync(out)) return out;
  const cx = w / 2, cy = h / 2, ax = w / 2 - R, ay = h / 2 - R;
  const expr = `if(lte(hypot(max(abs(X-${cx})-${ax},0),max(abs(Y-${cy})-${ay},0)),${R}),255,0)`;
  ff(['-f', 'lavfi', '-i', `color=black:s=${w}x${h}`, '-vf', `format=gray,geq=lum='${expr}'`, '-frames:v', '1', out]);
  return out;
}
// toạ độ overlay theo 9 vị trí
function xy(pos, dw, dh) {
  const P = { tl: ['l', 't'], tc: ['c', 't'], tr: ['r', 't'], cl: ['l', 'c'], center: ['c', 'c'], cr: ['r', 'c'], bl: ['l', 'b'], bc: ['c', 'b'], br: ['r', 'b'] };
  const [hx, vy] = P[pos] || P.center;
  const x = hx === 'l' ? M : hx === 'r' ? W - dw - M : Math.round((W - dw) / 2);
  const y = vy === 't' ? M : vy === 'b' ? H - dh - M : Math.round((H - dh) / 2);
  return { x, y };
}

let n = 0;
for (const sc of plan.scenes) {
  if (only && sc.i !== only) continue;
  if (sc.type !== 2 && sc.type !== 1) continue;
  const id = 'scene-' + String(sc.i).padStart(2, '0');
  const f = srcFiles.find((x) => x.startsWith(id + '.'));
  if (!f) { console.log(`· ${id}: chưa có source → placeholder`); continue; }
  const inP = join(srcDir, f);
  const outP = join(outDir, id + '.mp4');
  const dur = (Math.max(0.6, sc.dur) + 0.4).toFixed(2);   // pad +0.4s: b-roll phủ trọn window (hết lòi mặt lúc chuyển cảnh)
  const FPS = 30, frames = Math.max(2, Math.round(FPS * parseFloat(dur)));
  const img = isImg(f);
  const inArgs = img ? ['-loop', '1', '-t', dur, '-i', inP] : ['-ss', '0', '-t', dur, '-i', inP];
  const vcodec = ['-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p'];
  const framesArg = img ? ['-frames:v', String(frames)] : ['-t', dur];
  // vị trí crop (bset.cropX/cropY 0..100, mặc định giữa 50)
  const cx = (Math.min(100, Math.max(0, sc.bset?.cropX ?? 50)) / 100).toFixed(3);
  const cy = (Math.min(100, Math.max(0, sc.bset?.cropY ?? 50)) / 100).toFixed(3);
  const cropOff = `:x='(in_w-out_w)*${cx}':y='(in_h-out_h)*${cy}'`;
  const doZoom = img && ZOOM;   // zoom nhẹ chỉ cho ẢNH khi bật
  // cover-crop tw×th, có offset vị trí; ảnh+zoom → oversample 2x + zoompan
  const coverVf = (tw, th) => doZoom
    ? `scale=${tw * 2}:${th * 2}:force_original_aspect_ratio=increase,crop=${tw * 2}:${th * 2}${cropOff},zoompan=z='1+0.12*on/${frames}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=${frames}:s=${tw}x${th}:fps=${FPS},setsar=1`
    : `scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th}${cropOff},setsar=1`;

  if (sc.type === 1) {
    // SPLIT: cover-crop 1080×960 (offset vị trí + zoom nếu bật)
    console.log(`✂ ${id}: split ${f} → ${dur}s cropX=${cx} cropY=${cy} zoom=${doZoom}`);
    ff([...inArgs, '-vf', coverVf(W, HALF), ...framesArg, ...vcodec, outP]);
  } else {
    // FULL: áp bset
    const b = { fit: 'auto', scale: 1, pos: 'center', bg: 'white', round: true, ...(sc.bset || {}) };
    const { w, h } = probeWH(inP);
    // phát hiện phủ kín dùng contain-scale FULL khung (không phá nguồn dọc)
    const coverScale = Math.min(W / w, H / h) * (b.scale || 1);
    const covers = even(w * coverScale) >= W - 2 && even(h * coverScale) >= H - 2;
    let dw, dh;
    if (!covers) {
      // fit: chừa lề mặc định 56px; cap để dù scale lớn vẫn còn lề ≥24px -> KHÔNG BAO GIỜ chạm mép
      const PAD = 56;
      let s = Math.min((W - 2 * PAD) / w, (H - 2 * PAD) / h) * (b.scale || 1);
      s = Math.min(s, (W - 48) / w, (H - 48) / h);
      dw = even(w * s); dh = even(h * s);
    }
    if (covers) {
      // phủ kín → cover-crop (offset vị trí + zoom nếu bật)
      console.log(`✂ ${id}: full-cover ${f} (${w}×${h}) cropX=${cx} cropY=${cy} zoom=${doZoom} → ${dur}s`);
      ff([...inArgs, '-vf', coverVf(W, H), ...framesArg, ...vcodec, outP]);
    } else {
      // KHÔNG phủ kín → nền video + b-roll fit + bo góc + vị trí
      const bgPath = existsSync(BG[b.bg]) ? BG[b.bg] : BG.white;
      const { x, y } = xy(b.pos, dw, dh);
      const zoom = doZoom ? `,zoompan=z='1+0.10*on/${frames}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=${frames}:s=${dw}x${dh}:fps=${FPS}` : '';
      const inputs = ['-stream_loop', '-1', '-t', dur, '-i', bgPath, ...inArgs];
      let fc = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[bg];`;
      fc += `[1:v]scale=${dw}:${dh}${zoom},setsar=1[fg];`;
      if (b.round) { inputs.push('-i', mask(dw, dh)); fc += `[fg][2:v]alphamerge[fga];[bg][fga]overlay=${x}:${y}:format=auto[v]`; }
      else { fc += `[bg][fg]overlay=${x}:${y}[v]`; }
      console.log(`✂ ${id}: full-fit ${f} (${w}×${h}→${dw}×${dh}) bg=${b.bg} round=${b.round} pos=${b.pos} → ${dur}s`);
      ff([...inputs, '-filter_complex', fc, '-map', '[v]', ...framesArg, ...vcodec, outP]);
    }
  }
  // preview frame
  const pw = 540, ph = sc.type === 1 ? 480 : 960;
  const prevName = sc.type === 1 ? `${id}-top.jpg` : `${id}.jpg`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0.1, sc.dur / 2)), '-i', outP, '-frames:v', '1',
    '-vf', `scale=${pw}:${ph}:force_original_aspect_ratio=increase,crop=${pw}:${ph}`, '-q:v', '3', join(prevDir, prevName)],
    { stdio: 'ignore' });
  n++;
}
console.log(`CUT_DONE ${n} source(s)`);

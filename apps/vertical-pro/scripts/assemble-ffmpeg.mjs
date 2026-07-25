#!/usr/bin/env node
// assemble-ffmpeg.mjs — render final DỌC 1080×1920 bằng ffmpeg THUẦN (không Chrome/Hyperframes).
// Mô hình: mặt (face-final, NGANG) cover-crop dọc làm nền chạy suốt (audio gốc liền mạch);
// b-roll từng scene OVERLAY đè lên đúng [start,end]:
//   type 2 full  : broll 1080×1920 đè toàn khung
//   type 1 split : broll 1080×960 đè nửa TRÊN + mặt box 1080×960 đè nửa DƯỚI (crop né sát mặt)
//   type 3 face  : không overlay
// Scene 1/2 CHƯA có broll -> bỏ qua (mặt hiện) — không chặn render.
// Cuối: burn assets/captions.ass (libass) + mix nhạc 0.12 -> renders/final.mp4 (NVENC, fallback x264).
// Usage: node assemble-ffmpeg.mjs <projectDir>   (subtitles filter cần path tương đối -> tự cwd vào projectDir)

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const projDir = process.argv[2];
if (!projDir) { console.error('Usage: node assemble-ffmpeg.mjs <projectDir>'); process.exit(1); }
process.chdir(projDir);

const plan = JSON.parse(readFileSync('plan.json', 'utf8'));
const FACE = 'assets/face-final.mp4';
const ASS = 'assets/captions.ass';
const MUSIC = 'assets/music.mp3';
if (!existsSync(FACE)) { console.error('Thiếu assets/face-final.mp4'); process.exit(1); }
mkdirSync('renders', { recursive: true });

const W = 1080, H = 1920, HALF = 960;
const COVER_FULL = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
const COVER_HALF = `scale=${W}:${HALF}:force_original_aspect_ratio=increase,crop=${W}:${HALF},setsar=1`;

// ---- gom scene có broll ----
const shots = plan.scenes
  .filter((s) => (s.type === 1 || s.type === 2))
  .map((s) => ({ ...s, file: `assets/broll/scene-${String(s.i).padStart(2, '0')}.mp4` }))
  .filter((s) => existsSync(s.file));
const nSplitNeedFace = shots.filter((s) => s.type === 1).length;
// Lấp KHOẢNG HỞ giữa scene (build-cuts cắt dead-air → hở → lòi mặt nền):
// mỗi b-roll phủ tới START scene KẾ (giữ frame cuối qua khoảng nghỉ), thay vì dừng ở end của chính nó.
const nextStartOf = {};
plan.scenes.forEach((s, idx) => { nextStartOf[s.i] = plan.scenes[idx + 1]?.start ?? (plan.duration ?? s.end); });
const coverEnd = (s) => Math.max(s.end, nextStartOf[s.i]);

// ---- build filtergraph ----
// KHÔNG dùng [0:v]split=N (N nhánh scale song song làm nghẽn khi nhiều scene split —
// 16 overlay từng mất >5 phút). Mỗi scene split đọc mặt bằng INPUT RIÊNG -ss/-t:
// decoder chỉ giải đúng cửa sổ vài giây -> rẻ, graph phẳng.
const inputs = ['-i', FACE];
shots.forEach((s) => inputs.push('-i', s.file));
let nextIdx = shots.length + 1;
const faceBoxIdx = {};                       // shot k (split) -> input index
shots.forEach((s, k) => {
  if (s.type === 1) { faceBoxIdx[k] = nextIdx++; inputs.push('-ss', String(s.start), '-t', String((coverEnd(s) - s.start).toFixed(3)), '-i', FACE); }
});
const hasMusic = existsSync(MUSIC);
const musicIdx = nextIdx;
if (hasMusic) { inputs.push('-stream_loop', '-1', '-i', MUSIC); nextIdx++; }
// SFX click mỗi chuyển cảnh (path gốc — args array nên dấu cách OK)
const SFX = 'D:\\thanh\\CONTENTTA AGENCY\\2 MARKETING & SALE\\sound effects\\mouse click fix.MP3';
const sfxOn = plan.sfx !== false && existsSync(SFX);
const sfxIdx = nextIdx;
const bounds = plan.scenes.slice(1).map((s) => Math.round(s.start * 1000)).filter((ms) => ms > 0);
if (sfxOn && bounds.length) { inputs.push('-i', SFX); nextIdx++; }

const F = [];
F.push(`[0:v]${COVER_FULL}[base]`);

let cur = '[base]';
shots.forEach((s, k) => {
  const inp = `[${k + 1}:v]`;
  const en = `enable='between(t,${s.start},${coverEnd(s).toFixed(3)})'`;
  if (s.type === 2) {
    F.push(`${inp}setpts=PTS-STARTPTS+${s.start}/TB[b${k}]`);
    F.push(`${cur}[b${k}]overlay=0:0:${en}:eof_action=repeat[v${k}]`);
  } else {
    // split: broll nửa trên + mặt box nửa dưới (mặt từ input -ss riêng, PTS bắt đầu 0)
    F.push(`${inp}setpts=PTS-STARTPTS+${s.start}/TB[b${k}]`);
    F.push(`[${faceBoxIdx[k]}:v]setpts=PTS-STARTPTS+${s.start}/TB,${COVER_HALF}[fb${k}]`);
    F.push(`${cur}[b${k}]overlay=0:0:${en}:eof_action=repeat[t${k}]`);
    F.push(`[t${k}][fb${k}]overlay=0:${HALF}:${en}:eof_action=repeat[v${k}]`);
  }
  cur = `[v${k}]`;
});
// burn ASS (nếu có)
// fontsdir tương đối (cwd = projDir = projects/<slug>) -> ../../fonts = apps/vertical-pro/fonts,
// né escaping ổ đĩa "C:"/spaces trong filtergraph ffmpeg trên Windows.
if (existsSync(ASS)) { F.push(`${cur}subtitles=${ASS.replace(/\\/g, '/')}:fontsdir=../../fonts[vout]`); cur = '[vout]'; }
else { F.push(`${cur}null[vout]`); cur = '[vout]'; }
// audio: voice + nhạc nhẹ + SFX click mỗi chuyển cảnh
let aout = '0:a';
const amixIns = ['[0:a]'];
if (hasMusic) { F.push(`[${musicIdx}:a]volume=0.12[ma]`); amixIns.push('[ma]'); }
const useSfx = sfxOn && bounds.length;
if (useSfx) {
  const outs = bounds.map((_, i) => `[sx${i}]`).join('');
  F.push(`[${sfxIdx}:a]asplit=${bounds.length}${outs}`);   // nhân bản 1 input sfx thành N nhánh
  bounds.forEach((ms, i) => { F.push(`[sx${i}]adelay=${ms}|${ms},volume=0.22[sd${i}]`); amixIns.push(`[sd${i}]`); });
}
if (amixIns.length > 1) { F.push(`${amixIns.join('')}amix=inputs=${amixIns.length}:duration=first:normalize=0[aout]`); aout = '[aout]'; }

const DUR = (plan.duration ?? 0).toFixed(3);
// Chống lag máy: chừa 2 core cho hệ thống + chạy ffmpeg priority BELOW_NORMAL (nhường CPU khi user đang làm việc)
const FTHREADS = Math.max(2, os.cpus().length - 2);
const THREAD_FLAGS = process.env.NO_THREAD_LIMIT ? [] : ['-filter_complex_threads', String(FTHREADS), '-threads', String(FTHREADS)];
const common = ['-y', '-hide_banner', ...THREAD_FLAGS,
  ...inputs, '-filter_complex', F.join(';'), '-map', cur, '-map', aout,
  '-t', DUR, '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];

function tryEncode(vArgs, label) {
  console.log(`▶ encode ${label} (threads=${FTHREADS}, chừa 2 core cho máy)`);
  return new Promise((resolveP) => {
    const child = spawn('ffmpeg', [...common, ...vArgs, 'renders/final.mp4'], { stdio: ['ignore', 'inherit', 'pipe'] });
    // KHÔNG hạ priority (below-normal làm render 12s -> 8 phút khi máy bận); chống lag bằng chừa 2 core (FTHREADS)
    let err = '';
    child.stderr.on('data', (b) => { err += b.toString(); if (err.length > 60000) err = err.slice(-30000); });
    child.on('error', (e) => { console.error('spawn ffmpeg lỗi:', e.message); resolveP(false); });
    child.on('close', (code) => {
      if (code !== 0) { console.error(err.split('\n').slice(-12).join('\n')); resolveP(false); }
      else resolveP(true);
    });
  });
}
console.log(`Scenes: ${plan.scenes.length} | broll overlay: ${shots.length} (split=${nSplitNeedFace}) | ass=${existsSync(ASS)} | music=${hasMusic} | sfx=${useSfx ? bounds.length : 0}`);
if (process.env.DEBUG_FILTER) console.log(F.join(';\n'));
const okNv = await tryEncode(['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '21', '-pix_fmt', 'yuv420p'], 'NVENC');
if (!okNv) {
  console.log('NVENC fail → fallback libx264');
  if (!(await tryEncode(['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'], 'x264'))) process.exit(1);
}
console.log('ASSEMBLE_DONE renders/final.mp4');

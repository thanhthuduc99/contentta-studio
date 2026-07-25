#!/usr/bin/env node
// sub-preview.mjs — render 1 frame/preset (previews/sub-<id>.jpg) để XEM THỬ style phụ đề
// trước khi ghép. Frame = face cover-crop dọc 1080×1920 + burn caption theo preset (fontsdir bundled).
// Usage: node sub-preview.mjs <projectDir>
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStyles, presetArgs } from './sub-style.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GEN = resolve(__dirname, '..', '..', '..', 'contentta-shorts-skill', 'scripts', 'generate-ass.mjs');
const projDir = resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('Usage: node sub-preview.mjs <projectDir>'); process.exit(1); }
process.chdir(projDir);   // cwd = projects/<slug> -> path tương đối + fontsdir ../../fonts

const FACE = 'assets/face-final.mp4';
if (!existsSync(FACE)) { console.error('Thiếu assets/face-final.mp4'); process.exit(1); }
mkdirSync('previews', { recursive: true });

// transcript đang dùng cho caption (ưu tiên bản đã sửa text)
const trPath = existsSync('assets/transcript-captions.json') ? 'assets/transcript-captions.json' : 'assets/transcript-final.json';
// mốc có caption + có từ đang nói (để thấy highlight): ~40% số từ
let t = 1.5;
try {
  const tr = JSON.parse(readFileSync(trPath, 'utf8'));
  const ws = tr.words || [];
  if (ws.length) { const w = ws[Math.floor(ws.length * 0.4)]; t = +(w.start + (w.end - w.start) * 0.5).toFixed(2); }
} catch {}

const COVER = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1';
const done = [];
for (const s of loadStyles()) {
  const assRel = `assets/subprev-${s.id}.ass`;
  try {
    execFileSync('node', [GEN, trPath, assRel, '--marginv', '330', ...presetArgs(s)], { stdio: ['ignore', 'ignore', 'inherit'] });
    // -ss sau -i (output seek) để PTS giữ nguyên -> caption tại mốc t hiện đúng
    execFileSync('ffmpeg', ['-y', '-i', FACE, '-ss', String(t), '-frames:v', '1',
      '-vf', `${COVER},subtitles=${assRel}:fontsdir=../../fonts`, '-q:v', '3', `previews/sub-${s.id}.jpg`],
      { stdio: ['ignore', 'ignore', 'inherit'] });
    done.push(s.id);
    console.log(`preview: previews/sub-${s.id}.jpg`);
  } catch (e) {
    console.error(`preview ${s.id} lỗi:`, String(e.message || e).slice(0, 160));
  } finally {
    try { rmSync(assRel); } catch {}
  }
}
console.log('SUB_PREVIEW_DONE ' + done.join(','));

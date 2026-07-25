#!/usr/bin/env node
// yt-pick.mjs — tải đúng ĐOẠN YouTube (≤720p) → cắt+crop theo scene (cut-sources).
// Usage:
//   node yt-pick.mjs <projectDir> <sceneIndex> <urlOrVideoId> [--start <giây> --dur <giây>]
//   Không có --start: giữ mặc định *0:03-0:30 (dùng cho auto-suggest cũ).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < raw.length; i++) { if (raw[i].startsWith('--')) { flags[raw[i].slice(2)] = raw[i + 1]; i++; } else pos.push(raw[i]); }
const [projDir, sceneArg, urlOrId] = pos;
const idx = parseInt(sceneArg, 10);
if (!projDir || !idx || !urlOrId) { console.error('Usage: node yt-pick.mjs <projectDir> <sceneIndex> <urlOrVideoId> [--start s --dur s]'); process.exit(1); }

// tách videoId từ URL (v=, youtu.be/, shorts/, embed/) hoặc nhận id thô 11 ký tự
function parseId(s) {
  s = String(s).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|\/v\/)([\w-]{11})/);
  return m ? m[1] : s;
}
const videoId = parseId(urlOrId);

// đoạn cắt: có --start -> *start-end (giây); không -> mặc định cũ
let section = '*0:03-0:30';
if (flags.start != null) {
  const start = Math.max(0, parseFloat(flags.start) || 0);
  const dur = Math.min(60, Math.max(1, parseFloat(flags.dur ?? '6')));
  section = `*${start.toFixed(2)}-${(start + dur).toFixed(2)}`;
}

const id = 'scene-' + String(idx).padStart(2, '0');
const srcDir = join(projDir, 'assets', 'src');
mkdirSync(srcDir, { recursive: true });
for (const f of (existsSync(srcDir) ? readdirSync(srcDir) : [])) if (f.startsWith(id + '.')) { try { rmSync(join(srcDir, f)); } catch {} }

console.log(`Tải clip YouTube ${videoId} đoạn ${section}…`);
execFileSync('python', ['-m', 'yt_dlp',
  '-f', 'best[height<=720][ext=mp4]/best[height<=720]',
  '--download-sections', section, '--force-keyframes-at-cuts',
  '--no-playlist', '--no-warnings', '--no-part',
  '-o', join(srcDir, id + '.%(ext)s'),
  `https://youtu.be/${videoId}`], { stdio: 'inherit', timeout: 180000 });

console.log('Cắt + crop theo scene…');
execFileSync('node', [join(__dirname, 'cut-sources.mjs'), projDir, String(idx)], { stdio: 'inherit' });
console.log('PICK_DONE');

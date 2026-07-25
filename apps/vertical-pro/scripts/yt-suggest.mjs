#!/usr/bin/env node
// yt-suggest.mjs — CHỈ lấy metadata YouTube (KHÔNG tải video) cho 1 scene.
// yt-dlp --flat-playlist -J "ytsearchN:query" → list {id,title,dur,thumb,url}.
// Usage: node yt-suggest.mjs <projectDir> <sceneIndex> [--q "override"] [--n 5]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++; } else pos.push(argv[i]); }
const projDir = pos[0]; const idx = parseInt(pos[1], 10);
if (!projDir || !idx) { console.error('Usage: node yt-suggest.mjs <projectDir> <sceneIndex> [--q ...] [--n 5]'); process.exit(1); }
const N = Math.min(8, parseInt(flags.n ?? '5', 10));
const plan = JSON.parse(readFileSync(join(projDir, 'plan.json'), 'utf8'));
const sc = plan.scenes.find((s) => s.i === idx);
const q = String(flags.q || sc?.brollQuery || 'b-roll').trim();
const id = 'scene-' + String(idx).padStart(2, '0');
const outDir = join(projDir, 'assets', 'cand', id);
mkdirSync(outDir, { recursive: true });

let raw = '';
try {
  raw = execFileSync('python', ['-m', 'yt_dlp', '--flat-playlist', '-J', '--no-warnings', `ytsearch${N}:${q}`],
    { encoding: 'utf8', maxBuffer: 48 * 1024 * 1024, timeout: 30000 });
} catch (e) { raw = e.stdout?.toString() || ''; }   // yt-dlp đôi khi exit !=0 vẫn có JSON

const items = [];
try {
  const j = JSON.parse(raw);
  for (const e of (j.entries || [])) {
    if (!e || !e.id) continue;
    items.push({ id: e.id, title: (e.title || '').slice(0, 90), dur: e.duration || null, channel: e.channel || e.uploader || '', thumb: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, url: `https://youtu.be/${e.id}` });
  }
} catch {}
writeFileSync(join(outDir, 'suggest.json'), JSON.stringify({ q, items }, null, 2));
console.log(`SUGGEST_DONE ${items.length} q=${q}`);

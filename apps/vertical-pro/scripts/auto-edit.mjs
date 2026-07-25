#!/usr/bin/env node
// auto-edit.mjs — 1 video nguồn (NGANG) -> project scenes cho editor kéo-thả (deterministic).
// transcribe -> cắt vấp -> plan-scenes (1/2/3) -> captions.ass -> scene previews.
// KHÔNG Playwright, KHÔNG Hyperframes. B-roll do người kéo-thả trong app; render = assemble-ffmpeg.mjs.
// Usage: node auto-edit.mjs <projectDir> <sourceVideo>

import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPreset, presetArgs } from './sub-style.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = __dirname;                                  // apps/vertical-pro/scripts
const SHORTS = resolve(__dirname, '..', '..', '..', 'contentta-shorts-skill');
// nhạc chính = 3 track licensed của Contentta (apps/vertical-pro/music), chọn NGẪU NHIÊN 1 để đa dạng
const MUSIC_DIR = resolve(__dirname, '..', 'music');
const MUSIC_POOL = ['joyinsound.mp3', 'miromaxmusic.mp3', 'trailer.mp3'];
const MUSIC_FILE = MUSIC_POOL[Math.floor(Math.random() * MUSIC_POOL.length)];
const MUSIC = join(MUSIC_DIR, MUSIC_FILE);

const [projDirArg, source] = process.argv.slice(2);
if (!projDirArg || !source) { console.error('Usage: node auto-edit.mjs <projectDir> <sourceVideo>'); process.exit(1); }
const projDir = resolve(projDirArg);
const A = (p) => join(projDir, p);
const run = (cmd, args, opts = {}) => { console.log(`$ ${cmd} ${args.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}`); execFileSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd || projDir, env: { ...process.env, ...opts.env } }); };

for (const d of ['assets', 'assets/broll', 'assets/src', 'renders', 'previews']) mkdirSync(A(d), { recursive: true });

console.log('▶ [1/6] re-encode source → 1920×1080 H.264');
run('ffmpeg', ['-y', '-i', source, '-vf', 'scale=1920:1080:flags=lanczos', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', A('assets/face-base.mp4')]);

console.log('▶ [2/6] transcribe (OpenAI Whisper)');
run('node', [join(SHORTS, 'scripts', 'transcribe-openai.mjs'), A('assets/face-base.mp4'), A('assets/transcript.json'), '--lang', 'vi']);

console.log('▶ [3/6] cắt vấp + remap');
run('python', [join(SHORTS, 'scripts', 'build-cuts.py'), 'assets/transcript.json', 'assets/face-base.mp4', 'assets/face-final.mp4', '--restart', '--dedup', '--remap-out', 'assets/transcript-final.json'], { env: { PYTHONIOENCODING: 'utf-8' } });

console.log('▶ [4/6] scene plan (cắt theo câu/dấu phẩy, types 1/2/3)');
run('node', [join(SCRIPTS, 'plan-scenes.mjs'), 'assets/transcript-final.json', 'plan.json']);

console.log('▶ [5/6] captions.ass + nhạc');
run('node', [join(SHORTS, 'scripts', 'generate-ass.mjs'), 'assets/transcript-final.json', 'assets/captions.ass', '--marginv', '330', ...presetArgs(getPreset('luke'))]);
if (existsSync(MUSIC)) copyFileSync(MUSIC, A('assets/music.mp3'));
// settings mặc định: zoom ảnh TẮT, nhạc = 1 trong 3 track licensed (ngẫu nhiên), style phụ đề = luke
writeFileSync(A('settings.json'), JSON.stringify({ zoom: false, music: MUSIC_FILE, sub: { preset: 'luke' } }, null, 2));

console.log('▶ [6/6] ảnh đại diện mỗi scene');
run('node', [join(SCRIPTS, 'scene-previews.mjs'), '.']);

console.log('AUTO_EDIT_DONE');

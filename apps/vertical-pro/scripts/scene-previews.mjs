#!/usr/bin/env node
// scene-previews.mjs — sinh 1 ẢNH đại diện mỗi scene (KHÔNG render video) cho UI editor.
//   type 1 (split) & 3 (face): frame từ assets/face-final.mp4 tại giữa scene.
//   type 2 (full-video): nếu có assets/broll/scene-NN.mp4 -> frame từ đó; chưa có -> bỏ (UI vẽ placeholder).
//   type 4 (html): bỏ (UI tự vẽ keyword bằng DOM).
// Output: previews/sNN.jpg. Usage: node scene-previews.mjs <projectDir> [sceneIndex]
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const projDir = process.argv[2];
const only = process.argv[3] ? parseInt(process.argv[3], 10) : null;  // chỉ 1 scene (sau khi upload source)
if (!projDir) { console.error('Usage: node scene-previews.mjs <projectDir> [sceneIndex]'); process.exit(1); }
const plan = JSON.parse(readFileSync(join(projDir, 'plan.json'), 'utf8'));
const A = (p) => join(projDir, p);
mkdirSync(A('previews'), { recursive: true });
const face = A('assets/face-final.mp4');

const frame = (src, t, out, cover) => {
  const vf = cover ? 'scale=540:960:force_original_aspect_ratio=increase,crop=540:960' : 'scale=-2:600';
  execFileSync('ffmpeg', ['-y', '-ss', String(t.toFixed(2)), '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '3', out], { stdio: 'ignore' });
};

let made = 0;
for (const sc of plan.scenes) {
  if (only && sc.i !== only) continue;
  const id = 'scene-' + String(sc.i).padStart(2, '0');
  const out = A(`previews/${id}.jpg`);
  const mid = (sc.start + sc.end) / 2;
  try {
    if (sc.type === 1 || sc.type === 3) { if (existsSync(face)) { frame(face, mid, out, false); made++; } }
    else if (sc.type === 2) {
      const br = A(`assets/broll/${id}.mp4`);
      if (existsSync(br)) { frame(br, Math.max(0.1, sc.dur / 2), out, true); made++; }
    }
    // type 4: UI tự vẽ
  } catch (e) { console.error(`preview ${id} lỗi: ${e.message}`); }
}
console.log(`PREVIEWS_DONE ${made}`);

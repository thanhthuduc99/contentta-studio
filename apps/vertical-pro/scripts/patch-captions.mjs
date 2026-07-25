#!/usr/bin/env node
// patch-captions.mjs — regen captions.ass sau khi user SỬA TEXT scene trong editor.
// Đọc plan.json: scene có textEdited=true -> thay words trong cửa sổ [start,end] của
// transcript-final.json bằng từ mới (chia đều timing). KHÔNG đụng transcript-final gốc —
// ghi assets/transcript-captions.json rồi gọi generate-ass.mjs -> assets/captions.ass.
// Usage: node patch-captions.mjs <projectDir>

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPreset, presetArgs } from './sub-style.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHORTS = resolve(__dirname, '..', '..', '..', 'contentta-shorts-skill');
const projDir = resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('Usage: node patch-captions.mjs <projectDir>'); process.exit(1); }

const plan = JSON.parse(readFileSync(join(projDir, 'plan.json'), 'utf8'));
const t = JSON.parse(readFileSync(join(projDir, 'assets', 'transcript-final.json'), 'utf8'));

const edited = plan.scenes.filter((s) => s.textEdited && s.text && s.text.trim());
let patched = 0;
for (const sc of edited) {
  const newWords = sc.text.trim().split(/\s+/);
  const inWin = (w) => w.start >= sc.start - 0.01 && w.start < sc.end - 0.01;
  const first = t.words.findIndex(inWin);
  if (first < 0) continue;
  let last = first;
  while (last + 1 < t.words.length && inWin(t.words[last + 1])) last++;
  const w0 = t.words[first].start, w1 = t.words[last].end;
  const step = (w1 - w0) / newWords.length;
  const repl = newWords.map((w, i) => ({ word: w, start: +(w0 + i * step).toFixed(3), end: +(w0 + (i + 1) * step).toFixed(3) }));
  t.words.splice(first, last - first + 1, ...repl);
  // segment text trong cửa sổ cũng cập nhật (generate-ass chunk theo segment)
  for (const seg of t.segments || []) {
    if (seg.start >= sc.start - 0.01 && seg.start < sc.end - 0.01) seg.text = ' ' + sc.text.trim();
  }
  patched++;
}

const capJson = join(projDir, 'assets', 'transcript-captions.json');
writeFileSync(capJson, JSON.stringify(t));
// style phụ đề theo settings.sub.preset (mặc định luke)
let presetId = 'luke';
try { presetId = (JSON.parse(readFileSync(join(projDir, 'settings.json'), 'utf8')).sub || {}).preset || 'luke'; } catch {}
execFileSync('node', [join(SHORTS, 'scripts', 'generate-ass.mjs'), capJson, join(projDir, 'assets', 'captions.ass'), '--marginv', '330', ...presetArgs(getPreset(presetId))], { stdio: 'inherit' });
console.log(`PATCH_CAPTIONS_OK edited=${patched} preset=${presetId}`);

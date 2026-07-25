// sub-style.mjs — đọc public/sub-styles.json (4 preset phụ đề) + map preset -> flag cho generate-ass.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STYLES_PATH = join(__dirname, '..', 'public', 'sub-styles.json');

export function loadStyles() {
  try { return JSON.parse(readFileSync(STYLES_PATH, 'utf8')); } catch { return []; }
}
export function getPreset(id) {
  const all = loadStyles();
  return all.find((s) => s.id === id) || all[0] || null;
}
const FONTS_DIR = join(__dirname, '..', 'fonts');
// preset -> mảng arg cho generate-ass.mjs (màu hex không #, cờ 0/1)
export function presetArgs(p) {
  if (!p) return [];
  const args = [
    '--font', p.font,
    '--italic', p.italic ? '1' : '0',
    '--size', String(p.size || 74),
    '--primary', p.primary,
    '--active', p.active,
    '--outline-color', p.outline,
    '--outline', String(p.outlineW),
    '--shadow', String(p.shadow ?? 0),
    '--box', p.box || 'none',
    '--box-color', p.boxColor || '000000',
    '--upper', p.upper ? '1' : '0',
    '--mode', p.mode || 'fill',
  ];
  if (p.fontFile) args.push('--fontfile', join(FONTS_DIR, p.fontFile));   // đo width vẽ box bo góc
  if (p.round) args.push('--round', String(p.round));                     // bán kính bo góc (px)
  return args;
}

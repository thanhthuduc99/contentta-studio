#!/usr/bin/env node
// generate-ass.mjs — sinh captions.ass (karaoke dim→bright) từ transcript Whisper,
// để burn bằng ffmpeg subtitles/libass — KHÔNG cần Chrome render (pipeline Loại 2 v2).
//
// Chunk logic Y HỆT generate-captions.mjs: tách theo từng câu Whisper, gom 3–5 từ,
// ưu tiên ngắt ở khoảng lặng > 0.30s, gộp chunk lẻ (≤2 từ) cuối câu vào dòng trước.
//
// Style: Be Vietnam Pro Bold trắng, dim rgba(stardust,0.55) → bright #FAF7F5 theo lời (\k),
// outline Deep Space #070409. KHÔNG đỏ.
//
// Usage:
//   node generate-ass.mjs <transcript.json> <output.ass> [replacements.json] [--marginv 220] [--size 48]
//   --marginv: khoảng cách đáy (px @1080×1920). Face full ~430, split-screen mặt dưới ~150.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[i + 1]; i++; }
  else pos.push(args[i]);
}
const [inPath, outPath, repPath] = pos;
if (!inPath || !outPath) {
  console.error('Usage: node generate-ass.mjs <transcript.json> <output.ass> [replacements.json] [--marginv 220] [--size 48] [--playresx 1080] [--playresy 1920]');
  process.exit(1);
}
const PLAY_X = parseInt(flags.playresx ?? '1080', 10);
const PLAY_Y = parseInt(flags.playresy ?? '1920', 10);
const TIKTOK = flags.style === 'tiktok';   // chữ IN HOA trắng đặc, viền đen dày, KHÔNG box
// auto-scale defaults for non-vertical: marginv & size relative to PlayResY
const defMarginV = PLAY_Y < 1000 ? Math.round(PLAY_Y * 0.07) : 220;
const sizeRatio = TIKTOK ? 0.063 : 0.05, defSizeBase = TIKTOK ? 68 : 48;
const defSize = PLAY_Y < 1000 ? Math.round(PLAY_Y * sizeRatio) : defSizeBase;
const MARGIN_V = parseInt(flags.marginv ?? String(defMarginV), 10);
const SIZE = parseInt(flags.size ?? String(defSize), 10);

// ---- preset phụ đề data-driven (app truyền 4 style LUKE/HORMOZI/Ali/Umi) ----
// Bật khi có --mode; không có thì giữ đường cũ (tiktok/default) → backward compat.
const PRESET = flags.mode ? {
  font: flags.font || 'Be Vietnam Pro',
  italic: flags.italic === '1',
  primary: flags.primary || 'FFFFFF',
  active: flags.active || 'FFFFFF',
  outlineHex: flags['outline-color'] || '000000',
  outlineW: Math.max(0, parseFloat(flags.outline ?? '5')),
  shadow: Math.max(0, parseFloat(flags.shadow ?? '0')),
  box: flags.box || 'none',
  boxColor: flags['box-color'] || '000000',
  upper: flags.upper === '1',
  mode: flags.mode,
} : null;
const ROUND = PRESET ? Math.max(0, parseFloat(flags.round ?? '0')) : 0;   // bán kính bo góc box (px)
const FONTFILE = flags.fontfile || '';                                    // .ttf để đo width (khớp font burn)
const ROUND_BOX = !!(PRESET && PRESET.box === 'line' && ROUND > 0 && FONTFILE);
// hex 'RRGGBB' -> ASS '&HAABBGGRR' (BGR)
function assColor(hex, alpha = '00') {
  hex = String(hex).replace(/[^0-9a-fA-F]/g, '').padStart(6, '0').slice(-6);
  return `&H${alpha}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase();
}
function presetStyleLine(P) {
  const border = (P.box === 'line' && !ROUND_BOX) ? 3 : 1;   // round-box vẽ riêng -> Cap KHÔNG dùng BorderStyle 3
  const outCol = (P.box === 'line' && !ROUND_BOX) ? assColor(P.boxColor) : assColor(P.outlineHex);
  const outW = ROUND_BOX ? 0 : P.outlineW;                   // chữ nằm trên hộp -> khỏi viền
  const primary = assColor(P.primary);
  const secondary = P.mode === 'fill' ? assColor(P.primary, '78') : primary;  // fill: mờ -> sáng theo \k
  const back = assColor('000000', '64');
  const mL = Math.round(PLAY_X * 0.06);
  return `Style: Cap,${P.font},${SIZE},${primary},${secondary},${outCol},${back},1,${P.italic ? 1 : 0},0,0,100,100,0.6,0,${border},${outW},${P.shadow},2,${mL},${mL},${MARGIN_V},1`;
}
// style riêng để vẽ hộp bo góc (không viền/bóng); vị trí đặt bằng \an5\pos
function boxStyleLine() {
  return `Style: Box,${PRESET.font},${SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`;
}
// \p drawing: chữ nhật bo góc (0,0)->(w,h), bán kính r, góc bezier k=0.5523
function roundedRectPath(w, h, r) {
  r = Math.max(1, Math.min(r, w / 2, h / 2));
  const k = +(r * 0.5523).toFixed(1), R = (n) => Math.round(n);
  return `m ${R(r)} 0 l ${R(w - r)} 0 b ${R(w - r + k)} 0 ${R(w)} ${R(r - k)} ${R(w)} ${R(r)} `
    + `l ${R(w)} ${R(h - r)} b ${R(w)} ${R(h - r + k)} ${R(w - r + k)} ${R(h)} ${R(w - r)} ${R(h)} `
    + `l ${R(r)} ${R(h)} b ${R(r - k)} ${R(h)} 0 ${R(h - r + k)} 0 ${R(h - r)} `
    + `l 0 ${R(r)} b 0 ${R(r - k)} ${R(r - k)} 0 ${R(r)} 0`;
}
// đo width từng dòng bằng PIL (khớp font burn); fallback ước lượng theo ký tự
function measureWidths(lines) {
  try {
    const py = 'import sys,json\nfrom PIL import ImageFont\nd=json.load(sys.stdin)\nf=ImageFont.truetype(d["font"],int(d["size"]))\n'
      + 'def w(s):\n try: return f.getlength(s)\n except Exception:\n  b=f.getbbox(s); return b[2]-b[0]\n'
      + 'sys.stdout.write(json.dumps([round(w(s)) for s in d["lines"]]))';
    const r = spawnSync('python', ['-c', py], { input: JSON.stringify({ font: FONTFILE, size: SIZE, lines }), encoding: 'utf8' });
    if (r.status === 0 && r.stdout) { const arr = JSON.parse(r.stdout.trim()); if (Array.isArray(arr) && arr.length === lines.length) return arr; }
  } catch {}
  return lines.map((s) => Math.round([...s].length * SIZE * 0.5));
}

const t = JSON.parse(readFileSync(inPath, 'utf8'));
if (!Array.isArray(t.words) || !Array.isArray(t.segments)) {
  console.error('ERROR: transcript thiếu words[] hoặc segments[].');
  process.exit(1);
}
const REP = repPath ? JSON.parse(readFileSync(repPath, 'utf8')) : {};

const segBounds = t.segments.map((s) => s.start);
const segOf = (ws) => { let idx = 0; for (let i = 0; i < segBounds.length; i++) if (segBounds[i] <= ws + 0.001) idx = i; return idx; };

const words = t.words.map((w) => {
  let x = w.word;
  if (Object.prototype.hasOwnProperty.call(REP, x)) x = REP[x];
  return { w: x, s: +w.start.toFixed(2), e: +w.end.toFixed(2), seg: segOf(w.start) };
});

const segs = [];
const bySeg = {};
words.forEach((w) => { (bySeg[w.seg] = bySeg[w.seg] || []).push(w); });
Object.keys(bySeg).map(Number).sort((a, b) => a - b).forEach((si) => {
  const ws = bySeg[si];
  const chunks = [];
  let cur = [];
  for (let i = 0; i < ws.length; i++) {
    cur.push(ws[i]);
    const next = ws[i + 1];
    const gapNext = next ? next.s - ws[i].e : 99;
    if (!next || (cur.length >= 3 && gapNext > 0.30) || cur.length >= 5) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  while (chunks.length >= 2 && chunks[chunks.length - 1].length <= 2) {
    const last = chunks.pop();
    chunks[chunks.length - 1] = chunks[chunks.length - 1].concat(last);
  }
  chunks.forEach((c) => segs.push(c));
});

const fmtT = (sec) => {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60), cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(Math.min(cs, 99)).padStart(2, '0')}`;
};

// Colors ASS = &HAABBGGRR (BGR). Stardust #FAF7F5, Deep Space #070409.
// Dim = stardust alpha 55% hiển thị -> alpha byte 0x73. \k flip Secondary->Primary tại mốc từ.
const HEADER = `[Script Info]
Title: Contentta captions
ScriptType: v4.00+
PlayResX: ${PLAY_X}
PlayResY: ${PLAY_Y}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${PRESET
  ? presetStyleLine(PRESET) + (ROUND_BOX ? '\n' + boxStyleLine() : '')
  : TIKTOK
  ? `Style: Cap,Be Vietnam Pro,${SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0.6,0,1,${Math.max(8, Math.round(SIZE * 0.16))},0,2,${Math.round(PLAY_X * 0.06)},${Math.round(PLAY_X * 0.06)},${MARGIN_V},1`
  : `Style: Cap,Be Vietnam Pro,${SIZE},&H00F5F7FA,&H73F5F7FA,&H00090407,&H7F000000,1,0,0,0,100,100,0.5,0,1,${Math.max(1, Math.round(SIZE*0.05))},${Math.max(0.5, Math.round(SIZE*0.025) / 10)},2,${Math.round(PLAY_X * 0.07)},${Math.round(PLAY_X * 0.07)},${MARGIN_V},1`}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const PRE_ROLL = 0.10, POST_HOLD = 0.18, GUARD = 0.12;
const doUpper = PRESET ? PRESET.upper : TIKTOK;
const tok = (w) => (doUpper ? w.w.toUpperCase() : w.w).replace(/[{}]/g, '');
const boxW = ROUND_BOX ? measureWidths(segs.map((seg) => seg.map(tok).join(' '))) : [];
const TL = ROUND_BOX ? 1 : 0;   // chữ lên Layer 1 khi có hộp bo góc (Layer 0)
const lines = [];
segs.forEach((seg, i) => {
  const segStart = seg[0].s, segEnd = seg[seg.length - 1].e;
  const next = segs[i + 1];
  const start = Math.max(0, segStart - PRE_ROLL);
  let end = segEnd + POST_HOLD;
  if (next) end = Math.min(end, Math.max(next[0].s - GUARD, segStart + 0.1));
  if (ROUND_BOX) {
    // hộp bo góc phủ dòng: canh giữa dưới, cao hơn chữ 1 chút (Layer 0, dưới chữ)
    const PADX = Math.round(SIZE * 0.5), PADY = Math.round(SIZE * 0.26);
    const bw = (boxW[i] || Math.round(SIZE * 6)) + 2 * PADX, bh = SIZE + 2 * PADY;
    const cx = Math.round(PLAY_X / 2), cy = PLAY_Y - MARGIN_V - Math.round(SIZE * 0.30);
    const draw = `{\\an5\\pos(${cx},${cy})\\1c${assColor(PRESET.boxColor)}\\bord0\\shad0\\p1}${roundedRectPath(bw, bh, Math.min(ROUND, bh / 2))}{\\p0}`;
    lines.push(`Dialogue: 0,${fmtT(start)},${fmtT(end)},Box,,0,0,0,,{\\fad(80,80)}${draw}`);
  }
  if (PRESET && PRESET.mode === 'active') {
    // chỉ TỪ đang nói mang màu active; 1 Dialogue / trạng-thái-từ (dòng 3–5 từ)
    const aC = assColor(PRESET.active), pC = assColor(PRESET.primary);
    const toks = seg.map(tok);
    for (let j = 0; j < seg.length; j++) {
      const wStart = j === 0 ? start : seg[j].s;
      const wEnd = j < seg.length - 1 ? seg[j + 1].s : end;
      if (wEnd <= wStart) continue;
      const fIn = j === 0 ? 80 : 0, fOut = j === seg.length - 1 ? 80 : 0;
      let text = (fIn || fOut) ? `{\\fad(${fIn},${fOut})}` : '';
      text += toks.map((t, k) => (k === j ? `{\\1c${aC}}${t}{\\1c${pC}}` : t)).join(' ');
      lines.push(`Dialogue: ${TL},${fmtT(wStart)},${fmtT(wEnd)},Cap,,0,0,0,,${text}`);
    }
  } else {
    // fill: lead-in dim rồi từng từ sáng tại mốc start của nó (\k karaoke sweep)
    let text = `{\\fad(140,60)}{\\k${Math.round((segStart - start) * 100)}}`;
    for (let j = 0; j < seg.length; j++) {
      const w = seg[j], nx = seg[j + 1];
      const durCs = Math.max(1, Math.round(((nx ? nx.s : Math.min(w.e, end)) - w.s) * 100));
      text += `{\\k${durCs}}${tok(w)}${nx ? ' ' : ''}`;
    }
    lines.push(`Dialogue: 0,${fmtT(start)},${fmtT(end)},Cap,,0,0,0,,${text}`);
  }
});

writeFileSync(outPath, HEADER + lines.join('\n') + '\n', 'utf8');
console.error(`captions.ass written: ${segs.length} lines, marginV ${MARGIN_V} -> ${outPath}`);

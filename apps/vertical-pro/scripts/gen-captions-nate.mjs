#!/usr/bin/env node
// gen-captions-nate.mjs — captions.html karaoke kiểu Nate Herk: chữ TRẮNG outline đen,
// mỗi dòng có 1 từ NHẤN ĐỎ (#E10E1F). Dựa trên generate-captions.mjs (chunk theo câu).
// Usage: node gen-captions-nate.mjs <transcript.json> <out.html> [--marginv 300] [replacements.json]

import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++; }
  else pos.push(argv[i]);
}
const [inPath, outPath, repPath] = pos;
if (!inPath || !outPath) { console.error('Usage: node gen-captions-nate.mjs <transcript.json> <out.html> [--mute a-b,c-d] [rep.json]'); process.exit(1); }
// các khoảng thời gian TẮT caption (scene html / placeholder) — "start-end,start-end"
const MUTE = (flags.mute || '').split(',').map((r) => r.split('-').map(Number)).filter((x) => x.length === 2 && !isNaN(x[0]));
const muted = (s, e) => MUTE.some(([a, b]) => (s + e) / 2 >= a - 0.05 && (s + e) / 2 <= b + 0.05);

const t = JSON.parse(readFileSync(inPath, 'utf8'));
if (!Array.isArray(t.words) || !Array.isArray(t.segments)) { console.error('transcript thiếu words/segments'); process.exit(1); }
const REP = repPath ? JSON.parse(readFileSync(repPath, 'utf8')) : {};

const STOP = new Set(('như bạn là một mới về cũng với lại thì này sẽ cho các mà có thể để cái trong từ đến ra sao nó mình được và của người khi nếu hay những đã đang rồi cùng kì hữu ích theo dõi cách thế nào lần một').split(/\s+/));
const cl = (w) => w.replace(/[.,!?;:"'()]/g, '').toLowerCase();

const segBounds = t.segments.map((s) => s.start);
const segOf = (ws) => { let idx = 0; for (let i = 0; i < segBounds.length; i++) if (segBounds[i] <= ws + 0.001) idx = i; return idx; };
const words = t.words.map((w) => { let x = w.word; if (Object.prototype.hasOwnProperty.call(REP, x)) x = REP[x]; return { w: x, s: +w.start.toFixed(2), e: +w.end.toFixed(2), seg: segOf(w.start) }; });

const segs = [];
const bySeg = {};
words.forEach((w) => { (bySeg[w.seg] = bySeg[w.seg] || []).push(w); });
Object.keys(bySeg).map(Number).sort((a, b) => a - b).forEach((si) => {
  const ws = bySeg[si];
  const chunks = []; let cur = [];
  for (let i = 0; i < ws.length; i++) {
    cur.push(ws[i]);
    const next = ws[i + 1];
    const gapNext = next ? next.s - ws[i].e : 99;
    if (!next || (cur.length >= 3 && gapNext > 0.30) || cur.length >= 5) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  while (chunks.length >= 2 && chunks[chunks.length - 1].length <= 2) { const last = chunks.pop(); chunks[chunks.length - 1] = chunks[chunks.length - 1].concat(last); }
  chunks.forEach((c) => segs.push(c));
});

// chọn index từ nhấn đỏ mỗi chunk (token dài nhất / brand, không stopword)
function emphIdx(chunk) {
  let bi = -1, bs = 0;
  chunk.forEach((w, i) => { const c = cl(w.w); if (STOP.has(c) || c.length < 3) return; const sc = (/[A-Z0-9]/.test(w.w) ? 10 : 0) + c.length; if (sc > bs) { bs = sc; bi = i; } });
  return bi;
}

const segsKept = segs.filter((c) => !muted(c[0].s, c[c.length - 1].e));  // bỏ dòng rơi vào scene html/placeholder
const SEGLIT = segsKept.map((s) => {
  const ei = emphIdx(s);
  return '          { emph:' + ei + ', words: [' + s.map((w) => `{w:${JSON.stringify(w.w)},s:${w.s},e:${w.e}}`).join(',') + '] }';
}).join(',\n');
const DUR = (t.duration ?? (segs.at(-1).at(-1).e + 0.5)).toFixed(2);

const HTML = `<template id="captions-template">
  <div data-composition-id="captions" data-start="0" data-width="1080" data-height="1920" data-duration="${DUR}">
    <div class="cap-stage" id="cap-stage"></div>
    <style>
      [data-composition-id="captions"] { position:absolute; inset:0; pointer-events:none; }
      [data-composition-id="captions"] .cap-stage { position:absolute; inset:0; pointer-events:none; }
      [data-composition-id="captions"] .cap-line-wrap { position:absolute; top:50%; left:0; right:0; transform:translateY(-50%); display:flex; justify-content:center; padding:0 70px; opacity:0; visibility:hidden; }
      [data-composition-id="captions"] .cap-line { display:inline-block; max-width:940px; padding:0 8px; text-align:center; font-family:"Be Vietnam Pro",sans-serif; font-weight:800; font-size:64px; line-height:1.18; letter-spacing:.004em; color:#FFFFFF; text-shadow:-3px -3px 0 #070409,3px -3px 0 #070409,-3px 3px 0 #070409,3px 3px 0 #070409,0 0 10px rgba(0,0,0,.7),0 6px 18px rgba(0,0,0,.6); white-space:normal; }
      [data-composition-id="captions"] .cap-word { display:inline-block; margin:0 6px; transform-origin:center; will-change:color,transform; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <script>
      (function () {
        const SEGMENTS = [
${SEGLIT}
        ];
        const COMP_DURATION = ${DUR};
        const DIM = "rgba(255,255,255,0.42)", BRIGHT = "#FFFFFF";  // chỉ xám -> trắng, KHÔNG đỏ
        const stage = document.querySelector('[data-composition-id="captions"] #cap-stage');
        if (!stage) return;
        SEGMENTS.forEach(function (seg, si) {
          const wrap = document.createElement("div"); wrap.className = "cap-line-wrap"; wrap.id = "cap-seg-" + si;
          const line = document.createElement("div"); line.className = "cap-line";
          seg.words.forEach(function (w, wi) { const s = document.createElement("span"); s.className = "cap-word"; s.id = "cap-w-" + si + "-" + wi; s.textContent = w.w; line.appendChild(s); });
          wrap.appendChild(line); stage.appendChild(wrap);
        });
        const tl = gsap.timeline({ paused: true });
        const FADE_IN = 0.12, FADE_OUT = 0.06, PRE_ROLL = 0.10, SWAP_GUARD = 0.06, POST_HOLD = 0.16;
        SEGMENTS.forEach(function (seg, si) {
          const wrapSel = '[data-composition-id="captions"] #cap-seg-' + si;
          const segStart = seg.words[0].s, segEnd = seg.words[seg.words.length - 1].e;
          const nextSeg = SEGMENTS[si + 1];
          const nextStart = nextSeg ? nextSeg.words[0].s : COMP_DURATION + 1;
          const naturalExit = segEnd + POST_HOLD, forcedExit = nextStart - PRE_ROLL - SWAP_GUARD - FADE_OUT;
          const fadeOutAt = Math.max(segStart + 0.1, Math.min(naturalExit, forcedExit));
          const fadeInAt = Math.max(segStart - PRE_ROLL, 0);
          const hideAt = fadeOutAt + FADE_OUT + 0.02;
          seg.words.forEach(function (w, wi) { tl.set('[data-composition-id="captions"] #cap-w-' + si + "-" + wi, { color: DIM }, fadeInAt); });
          tl.set(wrapSel, { visibility: "visible" }, fadeInAt);
          tl.fromTo(wrapSel, { opacity: 0 }, { opacity: 1, duration: FADE_IN, ease: "power2.out" }, fadeInAt);  // chỉ fade opacity (giữ translateY -50%)
          seg.words.forEach(function (w, wi) {
            tl.to('[data-composition-id="captions"] #cap-w-' + si + "-" + wi, { color: BRIGHT, duration: 0.10, ease: "power2.out" }, w.s);
          });
          tl.to(wrapSel, { opacity: 0, duration: FADE_OUT, ease: "power2.in" }, fadeOutAt);
          tl.set(wrapSel, { visibility: "hidden" }, hideAt);
        });
        tl.set({}, {}, COMP_DURATION);
        window.__timelines = window.__timelines || {};
        window.__timelines["captions"] = tl;
      })();
    </script>
  </div>
</template>
`;
writeFileSync(outPath, HTML);
console.error(`captions(nate): ${segsKept.length}/${segs.length} lines (muted ${segs.length - segsKept.length}), dur ${DUR}s -> ${outPath}`);

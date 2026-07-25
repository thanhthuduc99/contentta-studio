#!/usr/bin/env node
// plan-scenes.mjs — từ transcript-final.json (word + segment) sinh SCENE PLAN video dọc Nate Herk.
// ĐỔI CẢNH CHỈ tại RANH GIỚI CÂU (segment Whisper) hoặc KHOẢNG NGHỈ ~dấu phẩy (gap >= --gap).
// Loại scene: 1=split · 2=full-video(b-roll) · 3=full-face · 4=html keyword.
// Luật mới: scene 1 LUÔN = 3 (video gốc full). Chủ yếu luân phiên full-face(3) / b-roll(2).
//           Chèn TỐI ĐA 1-2 slide HTML keyword (type 4), rải đều, không kề nhau, không phải scene đầu.
// Usage: node plan-scenes.mjs <transcript-final.json> <plan.json> [--gap 0.26] [--minclause 0.9] [--htmlmax 2]

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[i + 1]; i++; } else pos.push(args[i]); }
const [inPath, outPath] = pos;
if (!inPath || !outPath) { console.error('Usage: node plan-scenes.mjs <transcript-final.json> <plan.json> [--gap 0.26] [--minclause 0.9] [--htmlmax 2]'); process.exit(1); }
const GAP = parseFloat(flags.gap ?? '0.26');         // khoảng nghỉ rõ ~ dấu phẩy
const MINCLAUSE = parseFloat(flags.minclause ?? '2.5'); // mảnh ngắn hơn -> gộp (nhịp chậm, b-roll ~5-8s)
const TARGET = parseFloat(flags.target ?? '6.0');    // độ dài scene mong muốn (5-8s để có thời gian tìm b-roll)
const MAXSCENE = parseFloat(flags.maxscene ?? '8.0'); // câu dài hơn -> cắt tại các khoảng nghỉ lớn nhất
const HTMLMAX = parseInt(flags.htmlmax ?? '2', 10);

const t = JSON.parse(readFileSync(inPath, 'utf8'));
const words = (t.words || []).filter((w) => w.word && w.word.trim());
const segments = t.segments || [];
if (!words.length) { console.error('Không có word.'); process.exit(1); }

// gán word -> segment theo start
const segBounds = segments.map((s) => s.start);
const segOf = (ws) => { let idx = 0; for (let i = 0; i < segBounds.length; i++) if (segBounds[i] <= ws + 0.001) idx = i; return idx; };

// Cắt CHỈ tại chỗ nghỉ tự nhiên: ranh giới CÂU (segment) + các KHOẢNG NGHỈ trong câu.
// Câu dài hơn MAXSCENE -> chia thành k phần ~TARGET, đặt cắt tại (k-1) khoảng nghỉ LỚN NHẤT.
const bySeg = {};
words.forEach((w) => { (bySeg[segOf(w.start)] = bySeg[segOf(w.start)] || []).push(w); });
let chunks = [];
Object.keys(bySeg).map(Number).sort((a, b) => a - b).forEach((si) => {
  const ws = bySeg[si];
  let start = 0, bestCut = -1, bestGap = -1;
  for (let i = 0; i < ws.length; i++) {
    const curDur = ws[i].end - ws[start].start;
    const last = i === ws.length - 1;
    const gapAfter = last ? 99 : ws[i + 1].start - ws[i].end;
    const eligible = curDur >= MINCLAUSE;
    if (eligible && gapAfter > bestGap) { bestGap = gapAfter; bestCut = i; }  // nhớ chỗ nghỉ lớn nhất
    if (last) { chunks.push(ws.slice(start)); break; }
    const strongPause = gapAfter >= GAP && eligible;     // nghỉ rõ ~ dấu phẩy
    const tooLong = curDur >= MAXSCENE;                  // câu dài, phải cắt
    if (strongPause || tooLong) {
      const cutAt = (tooLong && bestCut >= 0) ? bestCut : i;   // cắt tại chỗ nghỉ lớn nhất
      chunks.push(ws.slice(start, cutAt + 1));
      start = cutAt + 1; bestCut = -1; bestGap = -1;
    }
  }
});
// gộp mảnh cuối quá ngắn vào trước
for (let i = chunks.length - 1; i > 0; i--) {
  const c = chunks[i];
  if (c[c.length - 1].end - c[0].start < MINCLAUSE) { chunks[i - 1] = chunks[i - 1].concat(c); chunks.splice(i, 1); }
}

// --- keyword + link gợi ý CHÍNH XÁC theo nội dung từng đoạn ---
const STOP = new Set(('như bạn là một mới về cũng với lại thì này sẽ cho các mà có thể để cái trong từ đến ra sao nó mình được và của người khi nếu hay những đã đang rồi cùng kì hữu ích theo dõi cách thế nào lần một rất hơn nữa vì nên thôi đó kia ấy thật khủng còn chỉ đây video mình muốn nghĩa thấy đều bây giờ tất cả những').split(/\s+/));
const clean = (w) => w.replace(/[.,!?;:"'()]/g, '').toLowerCase();
// chủ đề toàn video = keyword tần suất cao nhất
const freq = {};
words.forEach((w) => { const c = clean(w.word); if (!STOP.has(c) && c.length >= 3) freq[c] = (freq[c] || 0) + 1; });
// chủ đề: ưu tiên token brand (có số/dài), rồi tần suất
const TOPIC = (Object.entries(freq).map(([k, v]) => [k, v * (/[0-9]/.test(k) ? 4 : 1) * (k.length >= 4 ? 1.3 : 1)])
  .sort((a, b) => b[1] - a[1])[0] || ['video'])[0];
const EN_MAP = [[/n8n|hệ thống|workflow|tự động|automation/i, 'automation workflow'], [/\bai\b|trí tuệ|model/i, 'artificial intelligence'], [/build|code|lập trình/i, 'coding screen'], [/version|công cụ|tool|phần mềm/i, 'software interface'], [/data|dữ liệu/i, 'data dashboard'], [/carousel|slide|design|thiết kế/i, 'design carousel']];
const enTopic = (text) => (EN_MAP.find(([re]) => re.test(text)) || [, 'technology'])[1];
// top keyword RIÊNG của đoạn (distinct)
function sceneKeywords(ws) {
  const seen = new Set(), out = [];
  ws.map((w) => ({ w: w.word.replace(/[.,!?;:]$/, ''), c: clean(w.word) }))
    .filter((x) => !STOP.has(x.c) && x.c.length >= 3)
    .sort((a, b) => ((/[A-Z0-9]/.test(b.w) ? 10 : 0) + b.c.length) - ((/[A-Z0-9]/.test(a.w) ? 10 : 0) + a.c.length))
    .forEach((x) => { if (!seen.has(x.c)) { seen.add(x.c); out.push(x.w); } });
  return out.slice(0, 2);
}
function buildLinks(ws, text) {
  const kws = sceneKeywords(ws);
  const seenL = new Set(), uniq = [];
  for (const w of [...kws, TOPIC]) { const l = clean(w); if (l && !seenL.has(l)) { seenL.add(l); uniq.push(w); } }
  const vnQ = uniq.slice(0, 3).join(' ');      // keyword đoạn + chủ đề (dedup)
  const enQ = `${enTopic(text)} ${kws[0] && /[a-z0-9]/i.test(kws[0]) && kws[0].length < 12 ? '' : ''}`.trim() || 'technology';
  const e = encodeURIComponent;
  return {
    q: vnQ,
    note: `Chèn video: ${kws.join(', ') || TOPIC}`,
    links: [
      `https://www.youtube.com/results?search_query=${e(vnQ)}`,
      `https://www.google.com/search?tbm=vid&q=${e(vnQ)}`,
      `https://www.pexels.com/search/videos/${e(enQ)}/`,
    ],
  };
}

// --- gán loại scene: 1=split · 2=full-video · 3=full-face (ffmpeg pipeline, KHÔNG html) ---
// Hook đầu = mặt(3); giữa xen kẽ split/full; cuối = mặt(3) cho CTA.
const n = chunks.length;
const types = new Array(n).fill(1);
if (n >= 1) types[0] = 3;                     // hook = mặt nói
if (n >= 2) types[n - 1] = 3;                 // cuối = mặt (CTA)
const CYCLE = [1, 2, 3];                      // giữa: split → full → mặt (1/3 nghỉ mặt, đỡ phải tìm b-roll mọi scene)
for (let i = 1; i <= n - 2; i++) types[i] = CYCLE[(i - 1) % CYCLE.length];

const scenes = chunks.map((ws, idx) => {
  const start = +ws[0].start.toFixed(2);
  const end = +ws[ws.length - 1].end.toFixed(2);
  const text = ws.map((w) => w.word).join(' ').replace(/\s+([.,!?;:])/g, '$1').trim();
  const type = types[idx];
  const kw = sceneKeywords(ws);
  const sc = { i: idx + 1, type, start, end, dur: +(end - start).toFixed(2), text, emphasis: kw[0] || '' };
  if (type === 1 || type === 2) { const L = buildLinks(ws, text); sc.brollQuery = L.q; sc.searchLinks = L.links; sc.note = L.note; }
  return sc;
});

const plan = { id: 'plan', duration: +(t.duration ?? words[words.length - 1].end).toFixed(3), fps: 30, width: 1080, height: 1920, scenes };
writeFileSync(outPath, JSON.stringify(plan, null, 2));
const counts = scenes.reduce((a, s) => ((a[s.type] = (a[s.type] || 0) + 1), a), {});
console.log(`OK ${scenes.length} scenes -> ${outPath}`);
console.log('types:', scenes.map((s) => s.type).join('-'), '| counts', JSON.stringify(counts));
scenes.forEach((s) => console.log(`  #${s.i} T${s.type} [${s.start}-${s.end}] (${s.dur}s) "${s.text.slice(0, 50)}"${s.brollQuery ? ' q=' + s.brollQuery : ''}`));

#!/usr/bin/env node
// broll-director.mjs — đọc plan.json, với MỖI scene cần b-roll quyết định CLIP VIDEO loại gì + lấy bằng cách nào.
// Triết lý Nate Herk: b-roll là VIDEO chụp/dựng đúng thứ đang nói, KHÔNG đi tìm stock.
//   screencap = câu nhắc tên tool/web  -> Playwright QUAY màn hình cuộn trang
//   montage   = câu nhắc output/kết quả-> ffmpeg PAN ngang/zoom từ bộ ảnh anh cấp
//   stock     = danh từ hình ảnh chung -> pixabay video (fallback)
//   (scene type 4/3 không qua đây: 4=caption HTML builder lo, 3=mặt full)
// Khớp scene.i của plan.json -> target assets/broll/scene-NN.mp4 (builder tự nhặt nếu file tồn tại).
// Usage: node broll-director.mjs <plan.json> <out-shotlist.json> [--urls broll-urls.json]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[i + 1]; i++; } else pos.push(args[i]); }
const [planPath, outPath] = pos;
if (!planPath || !outPath) { console.error('Usage: node broll-director.mjs <plan.json> <shotlist.json> [--urls broll-urls.json]'); process.exit(1); }

// Tool/web có tên riêng -> URL Playwright quay. Mở rộng bằng broll-urls.json { "tools": {...} }.
const TOOLS = {
  claude: 'https://claude.ai', 'cloud design': 'https://claude.ai', 'claude design': 'https://claude.ai',
  chatgpt: 'https://chatgpt.com', openai: 'https://openai.com', gpt: 'https://chatgpt.com',
  n8n: 'https://n8n.io', make: 'https://make.com', zapier: 'https://zapier.com',
  midjourney: 'https://midjourney.com', gemini: 'https://gemini.google.com', perplexity: 'https://perplexity.ai',
  figma: 'https://figma.com', canva: 'https://canva.com', notion: 'https://notion.so',
  cursor: 'https://cursor.com', v0: 'https://v0.dev', runway: 'https://runwayml.com',
};
const OUTPUT_CUES = ['carousel', 'slide', 'layout', 'design', 'thiết kế', 'bài đăng', 'post',
  'dashboard', 'kết quả', 'output', 'mockup', 'giao diện', 'template', 'reel', 'thumbnail'];
const STOCK_CUES = ['laptop', 'máy tính', 'code', 'lập trình', 'data', 'dữ liệu', 'office', 'team', 'phone', 'điện thoại'];

const STOP = new Set('như bạn là một mới về với lại thì này sẽ cho các mà có thể để cái trong từ đến ra sao nó mình được và của người khi nếu hay những đã đang rồi cùng theo dõi cách thế nào rất hơn nữa vì nên thôi đó ấy thật chỉ đây video muốn nghĩa thấy đều bây giờ tất cả'.split(/\s+/));
const clean = (w) => w.replace(/[.,!?;:"'()]/g, '').toLowerCase();
const norm = (s) => ' ' + String(s).toLowerCase().replace(/[.,!?;:"'()]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const urls = flags.urls && existsSync(flags.urls) ? JSON.parse(readFileSync(flags.urls, 'utf8')) : {};
Object.assign(TOOLS, urls.tools || {});
const sceneOverride = urls.scenes || {};   // { "2": {"url":"..."} | {"src":"folder"} | {"kind":"caption"} }

function keywords(text) {
  return text.split(/\s+/).map((w) => ({ w: w.replace(/[.,!?;:]$/, ''), c: clean(w) }))
    .filter((x) => x.c.length >= 3 && !STOP.has(x.c))
    .filter((x, i, arr) => arr.findIndex((y) => y.c === x.c) === i)
    .sort((a, b) => ((/[A-Z0-9]/.test(b.w) ? 9 : 0) + b.c.length) - ((/[A-Z0-9]/.test(a.w) ? 9 : 0) + a.c.length))
    .slice(0, 3).map((x) => x.w);
}
function classify(text) {
  const low = norm(text);
  for (const [name, url] of Object.entries(TOOLS)) if (low.includes(' ' + name + ' ')) return { kind: 'screencap', name, url };
  for (const cue of OUTPUT_CUES) if (low.includes(' ' + cue + ' ')) return { kind: 'montage', cue };
  for (const cue of STOCK_CUES) if (low.includes(' ' + cue + ' ')) return { kind: 'stock', cue };
  return { kind: 'none' };  // builder dùng card/placeholder HTML
}

const needs = [];
const shots = plan.scenes
  .filter((sc) => sc.type === 1 || sc.type === 2)   // chỉ scene tiêu thụ b-roll video
  .map((sc) => {
    const n = String(sc.i).padStart(2, '0');
    const target = `assets/broll/scene-${n}.mp4`;
    const kw = keywords(sc.text || '');
    const ov = sceneOverride[String(sc.i)] || {};
    let c = ov.kind ? { kind: ov.kind } : classify(sc.text || '');
    if (ov.url) c = { kind: 'screencap', url: ov.url };
    if (ov.src) c = { kind: 'montage', src: ov.src };

    const shot = { i: sc.i, sceneType: sc.type, start: sc.start, end: sc.end, dur: sc.dur, text: sc.text, kind: c.kind, emphasis: kw[0] || '', keywords: kw, target };
    if (c.kind === 'screencap') {
      shot.url = c.url || null;
      if (!shot.url) { shot.ready = false; needs.push(`#${sc.i} screencap → CẦN url tool (broll-urls.json scenes["${sc.i}"].url). Câu: "${sc.text.slice(0, 50)}"`); }
      else shot.ready = true;
    } else if (c.kind === 'montage') {
      shot.src = c.src || `assets/broll/src/scene-${n}`;
      shot.ready = null;   // fetch-broll kiểm folder ảnh có/không
      needs.push(`#${sc.i} montage → BỎ ẢNH output vào ${shot.src}/ (carousel/slide...). Câu: "${sc.text.slice(0, 50)}"`);
    } else if (c.kind === 'stock') {
      shot.query = (kw[0] && /[a-z]/i.test(kw[0]) ? kw[0] + ' ' : '') + 'technology';
      shot.ready = true;
    } else {
      shot.ready = true;   // none → builder fallback, không cần fetch
    }
    return shot;
  });

writeFileSync(outPath, JSON.stringify({ source: planPath, count: shots.length, shots }, null, 2));
const tally = shots.reduce((a, s) => ((a[s.kind] = (a[s.kind] || 0) + 1), a), {});
console.log(`OK ${shots.length} b-roll scenes -> ${outPath}`);
console.log('phân loại:', JSON.stringify(tally));
shots.forEach((s) => console.log(`  #${s.i} T${s.sceneType} [${s.start}-${s.end}] ${s.kind.toUpperCase().padEnd(9)} ${s.url || s.src || s.query || ''}  "${(s.text || '').slice(0, 45)}"`));
if (needs.length) { console.log('\n⚠ CẦN ANH CẤP (1 lượt):'); needs.forEach((n) => console.log('  • ' + n)); }

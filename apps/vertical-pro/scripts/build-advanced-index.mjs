#!/usr/bin/env node
// build-advanced-index.mjs — ráp index.html video dọc Nate Herk từ plan.json.
// Mô hình: MẶT full-bleed nằm nền (track -1, luôn thấy). Scene = OVERLAY đục bật/tắt theo câu:
//   T1 split -> card-light (panel trắng nửa trên, mặt lộ nửa dưới)
//   T2 full-video -> b-roll <video> full khung (assets/broll/sNN.mp4)
//   T3 full-face -> KHÔNG overlay (thấy mặt full)
//   T4 html -> kinetic-light full khung
// Voice + music = <audio>. Captions track 5 (chạy gen-captions-nate.mjs riêng trước/sau).
// Usage: node build-advanced-index.mjs <projectDir> [--music <abs.mp3>] [--title "..."]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TPL_DIR = join(__dirname, '..', 'templates', 'scene-light');

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++; } else pos.push(argv[i]); }
const projDir = pos[0];
if (!projDir) { console.error('Usage: node build-advanced-index.mjs <projectDir> [--music abs.mp3] [--title ...]'); process.exit(1); }

const plan = JSON.parse(readFileSync(join(projDir, 'plan.json'), 'utf8'));
const { width, height, scenes } = plan;
const DUR = +plan.duration.toFixed(2);
const TITLE = flags.title || 'Contentta · Vertical Pro';
const KICKERS = ['BẮT ĐẦU', 'Ý TƯỞNG', 'LƯU Ý', 'TRỌNG TÂM', 'CÁCH LÀM', 'KẾT QUẢ'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (s) => s.replace(/[.,!?;:"'()]/g, '').toLowerCase();

// wrap từ nhấn (accent) trong text bằng <span class="ac">
function wrapAccent(text, accent) {
  const words = text.split(/\s+/);
  const a = clean(accent);
  let done = false;
  return words.map((w) => {
    if (!done && a && clean(w) === a) { done = true; return `<span class="ac">${esc(w)}</span>`; }
    return esc(w);
  }).join(' ');
}
// chia headline thành tối đa N dòng (cho kinetic)
function splitLines(text, accent, maxLines = 3) {
  const words = text.split(/\s+/);
  const per = Math.ceil(words.length / Math.min(maxLines, Math.max(1, Math.ceil(words.length / 3))));
  const lines = [];
  for (let i = 0; i < words.length; i += per) lines.push(words.slice(i, i + per).join(' '));
  return lines.slice(0, maxLines).map((ln) => `<div class="kl-line">${wrapAccent(ln, accent)}</div>`).join('');
}

function fill(tplName, repl) {
  let s = readFileSync(join(TPL_DIR, tplName), 'utf8');
  for (const [k, v] of Object.entries(repl)) s = s.split(k).join(v);
  return s;
}

// --- sinh composition file cho từng scene T1/T4 ---
const sceneTags = [];   // các thẻ overlay trong index
const brollTags = [];
const muteRanges = [];  // khoảng TẮT caption (scene html/placeholder)
let kIdx = 0;
for (const sc of scenes) {
  const id = `scene-${String(sc.i).padStart(2, '0')}`;
  const dur = +sc.dur.toFixed(2);
  if (sc.type === 1) {
    const src = `assets/broll/${id}.mp4`;
    if (existsSync(join(projDir, src))) {
      // SPLIT có source → b-roll nửa TRÊN (1080×960), mặt nửa dưới
      brollTags.push(`      <video class="broll-top" id="v-${id}" data-start="${sc.start}" data-duration="${dur}" data-track-index="3" src="${src}" muted playsinline></video>`);
    } else {
      // SPLIT chưa có source → card HTML nửa trên (fallback)
      const head = wrapAccent(sc.htmlPayload?.headline || sc.text, sc.emphasis);
      const kicker = KICKERS[kIdx++ % KICKERS.length];
      const file = `compositions/${id}-card.html`;
      writeFileSync(join(projDir, file), fill('card-light.html', { __COMP_ID__: id, __DUR__: dur, __KICKER__: esc(kicker), __HEAD_HTML__: head }));
      sceneTags.push(`      <div class="scene-layer" data-composition-id="${id}" data-composition-src="${file}" data-start="${sc.start}" data-duration="${dur}" data-track-index="4" data-width="${width}" data-height="${height}" style="z-index:4"></div>`);
    }
  } else if (sc.type === 4) {
    const head = wrapAccent(sc.htmlPayload?.headline || sc.text, sc.htmlPayload?.accent || sc.emphasis);
    const file = `compositions/${id}-kinetic.html`;
    writeFileSync(join(projDir, file), fill('kinetic-complex.html', { __COMP_ID__: id, __DUR__: dur, __KICKER__: esc(sc.htmlPayload?.topic ? sc.htmlPayload.topic.toUpperCase() : 'CONTENTTA'), __HEAD_HTML__: head }));
    sceneTags.push(`      <div class="scene-layer" data-composition-id="${id}" data-composition-src="${file}" data-start="${sc.start}" data-duration="${dur}" data-track-index="4" data-width="${width}" data-height="${height}" style="z-index:4"></div>`);
    muteRanges.push(`${sc.start}-${sc.end}`);
  } else if (sc.type === 2) {
    const src = `assets/broll/${id}.mp4`;
    if (existsSync(join(projDir, src))) {
      brollTags.push(`      <video class="broll" id="v-${id}" data-start="${sc.start}" data-duration="${dur}" data-track-index="3" src="${src}" muted playsinline></video>`);
    } else {
      // chưa có source → placeholder "cần chèn video"
      const note = esc(sc.note || `Chèn video: ${sc.emphasis || ''}`);
      const file = `compositions/${id}-placeholder.html`;
      writeFileSync(join(projDir, file), fill('placeholder-light.html', { __COMP_ID__: id, __DUR__: dur, __NOTE__: note }));
      sceneTags.push(`      <div class="scene-layer" data-composition-id="${id}" data-composition-src="${file}" data-start="${sc.start}" data-duration="${dur}" data-track-index="4" data-width="${width}" data-height="${height}" style="z-index:4"></div>`);
      muteRanges.push(`${sc.start}-${sc.end}`);   // tắt caption trên placeholder
    }
  }
  // T3: không overlay
}

// face geometry + hiện/ẩn per scene.
//   T1 split  = box đáy 1080×960, HIỆN mặt (nửa dưới)
//   T3 full   = full 1080×1920, HIỆN mặt
//   T2/T4     = ẨN mặt (autoAlpha:0) → hết lòi mặt lúc chuyển cảnh; split→full đổi sạch
const FULL = '{top:0,height:1920,autoAlpha:1}', BOX = '{top:960,height:960,autoAlpha:1}', HIDE = '{autoAlpha:0}';
const faceState = (t) => (t === 1 ? BOX : t === 3 ? FULL : HIDE);
const faceSetLines = [`      mainTl.set('#face-wrapper', ${faceState(scenes[0]?.type)}, 0);`];
scenes.forEach((sc) => { faceSetLines.push(`      mainTl.set('#face-wrapper', ${faceState(sc.type)}, ${sc.start});`); });
const faceSetJs = faceSetLines.join('\n');

const music = flags.music && existsSync(flags.music)
  ? `\n      <audio id="music" data-start="0" data-duration="${DUR}" data-track-index="2" data-volume="0.08" src="${flags.music.replace(/\\/g, '/')}"></audio>`
  : '';

const HTML = `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${esc(TITLE)}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600&display=block" rel="stylesheet" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #070409; font-family: 'Be Vietnam Pro', sans-serif; }
      /* MẶT nền — full-bleed (T3) hoặc box đáy 1080×960 (T1 split). Geometry cắt cứng theo scene qua GSAP. */
      #face-wrapper { position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; overflow: hidden; z-index: 1; background:#000; box-shadow: 0 -4px 0 0 rgba(225,14,31,.55); }
      #face-video { width: 100%; height: 100%; object-fit: cover; object-position: center 28%; display: block; filter: contrast(1.04) saturate(1.05); }
      /* b-roll full khung */
      .broll { position: absolute; inset: 0; width: ${width}px; height: ${height}px; object-fit: cover; object-position: center center; display: block; z-index: 3; background:#070409; animation: brollIn .38s cubic-bezier(.2,.7,.2,1) both; }
      /* split-top: b-roll nửa trên 1080×960 (mặt ở box đáy) */
      .broll-top { position: absolute; left: 0; top: 0; width: ${width}px; height: 960px; object-fit: cover; object-position: center center; display: block; z-index: 3; background:#070409; animation: brollIn .38s cubic-bezier(.2,.7,.2,1) both; }
      .seam-red { position:absolute; left:0; top:954px; width:${width}px; height:6px; z-index:6; background:linear-gradient(90deg,rgba(225,14,31,0),rgba(225,14,31,.6),rgba(225,14,31,0)); }
      @keyframes brollIn { from { transform: scale(1.10); } to { transform: scale(1.0); } }
      .scene-layer { position: absolute; top: 0; left: 0; width: ${width}px; height: ${height}px; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="${plan.id || 'nate-demo'}" data-start="0" data-duration="${DUR}" data-width="${width}" data-height="${height}">

      <!-- MẶT (nền full-bleed) -->
      <div id="face-wrapper">
        <video id="face-video" data-start="0" data-duration="${DUR}" data-track-index="-1" src="assets/face-final.mp4" muted playsinline></video>
      </div>

      <!-- AUDIO -->
      <audio id="voice" data-start="0" data-duration="${DUR}" data-track-index="1" data-volume="1.0" src="assets/voice.m4a"></audio>${music}

      <!-- B-ROLL (track 3, full khung) -->
${brollTags.join('\n') || '      <!-- (không có scene full-video) -->'}

      <!-- SCENE OVERLAYS HTML (track 4) -->
${sceneTags.join('\n') || '      <!-- (không có scene html) -->'}

      <!-- CAPTIONS (track 5) -->
      <div class="scene-layer" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="${DUR}" data-track-index="5" data-width="${width}" data-height="${height}" style="z-index:7"></div>
    </div>

    <script>
      window.__timelines = window.__timelines || {};
      const mainTl = gsap.timeline({ paused: true });
      // Khung mặt: T1 split = box đáy 1080×960 ; T3 = full 1080×1920. Cắt cứng tại đầu mỗi scene.
${faceSetJs}
      mainTl.to({}, { duration: ${DUR} }, 0);
      window.__timelines["${plan.id || 'nate-demo'}"] = mainTl;
    </script>
  </body>
</html>
`;

writeFileSync(join(projDir, 'index.html'), HTML);
console.log(`index.html written: ${scenes.length} scenes, dur ${DUR}s | overlays=${sceneTags.length} broll=${brollTags.length}`);

// (Re)generate captions với mute range = scene html + placeholder (tránh caption đè chữ slide)
if (flags.captions) {
  const tr = flags.captions;
  console.log(`captions: mute=[${muteRanges.join(',')}]`);
  execFileSync('node', [join(__dirname, 'gen-captions-nate.mjs'), tr, join(projDir, 'compositions', 'captions.html'), '--mute', muteRanges.join(',')], { stdio: 'inherit' });
}

#!/usr/bin/env node
// ai-source.mjs — tạo b-roll bằng AI (fal.ai): đọc caption cảnh → prompt JSON (headless Claude,
// fallback template) → sinh ẢNH (FLUX) hoặc VIDEO (Hailuo) → assets/src/scene-NN.* → cut-sources.
// Usage: node ai-source.mjs <projectDir> <sceneIndex> --kind image|video [--model <falModelId>]
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < raw.length; i++) { if (raw[i].startsWith('--')) { flags[raw[i].slice(2)] = raw[i + 1]; i++; } else pos.push(raw[i]); }
const [projDir, sceneArg] = pos;
const idx = parseInt(sceneArg, 10);
const kind = flags.kind === 'image' ? 'image' : 'video';
if (!projDir || !idx) { console.error('Usage: node ai-source.mjs <projectDir> <sceneIndex> --kind image|video [--model id]'); process.exit(1); }

// video mặc định = WAN 2.2 (hỗ trợ DỌC 9:16/1:1 → khớp khung dọc + chỉnh vị trí được; Hailuo chỉ ngang)
const DEFAULT_MODEL = { image: 'fal-ai/flux/schnell', video: 'fal-ai/wan/v2.2-a14b/text-to-video' };
const model = flags.model || DEFAULT_MODEL[kind];

// FAL_KEY: process.env (server nạp .env) hoặc tự tìm .env đi lên
function falKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY.trim();
  let dir = projDir;
  for (let i = 0; i < 6; i++) {
    const p = join(dir, '.env');
    if (existsSync(p)) { const m = readFileSync(p, 'utf8').match(/FAL_KEY\s*=\s*(.+)/); if (m) return m[1].trim().replace(/^["']|["']$/g, ''); }
    dir = dirname(dir);
  }
  return '';
}
const KEY = falKey();
if (!KEY) { console.error('ERROR: thiếu FAL_KEY trong .env (tạo tài khoản fal.ai để lấy key).'); process.exit(1); }

const plan = JSON.parse(readFileSync(join(projDir, 'plan.json'), 'utf8'));
const sc = plan.scenes.find((s) => s.i === idx);
if (!sc) { console.error('không thấy scene ' + idx); process.exit(1); }
const text = (sc.text || '').trim();
const dur = Math.max(1, sc.dur || 4);
const isFull = sc.type === 2;

// ---- prompt JSON: nhờ headless Claude phân tích keyword; fallback template ----
function buildPrompt() {
  const ask = `Bạn tạo prompt cho model sinh B-ROLL minh hoạ (không có người nói trực diện) từ 1 caption tiếng Việt.
Caption cảnh: "${text}"
Trả về DUY NHẤT 1 JSON (không markdown, không giải thích) dạng:
{"prompt":"<mô tả cảnh b-roll bằng TIẾNG ANH, cinematic, cụ thể theo keyword chính, no text, no watermark>","motion":"<chuyển động camera ngắn>"}`;
  try {
    const r = spawnSync('claude', ['-p', '--model', 'sonnet', '--output-format', 'text'],
      { input: ask, encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000 });
    const out = (r.stdout || '').trim();
    const m = out.match(/\{[\s\S]*\}/);
    if (m) { const j = JSON.parse(m[0]); if (j.prompt) return j; }
  } catch (e) { console.error('prompt Claude lỗi → template:', e.message); }
  return { prompt: `cinematic b-roll footage illustrating: ${text}. high detail, realistic, natural lighting, no text, no watermark`, motion: 'slow subtle camera move' };
}
const p = buildPrompt();
const fullPrompt = `${p.prompt}${p.motion ? ', ' + p.motion : ''}`;
console.log(`AI ${kind} · model ${model} · prompt: ${fullPrompt.slice(0, 140)}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' };

async function genImage() {
  // DỌC để khớp khung + chỉnh vị trí được: full = 9:16 (phủ kín), split = 3:4 (phủ nửa trên, còn dư ~480px để pan dọc)
  const image_size = isFull ? 'portrait_16_9' : 'portrait_4_3';
  const res = await fetch(`https://fal.run/${model}`, { method: 'POST', headers: H,
    body: JSON.stringify({ prompt: fullPrompt, image_size, num_images: 1, enable_safety_checker: true }) });
  if (!res.ok) throw new Error(`fal image ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const url = j.images?.[0]?.url || j.image?.url;
  if (!url) throw new Error('fal image: không có url trả về');
  return { url, ext: 'png' };
}

async function genVideo() {
  const body = { prompt: fullPrompt };
  const aspect = isFull ? '9:16' : '1:1';   // DỌC: full phủ kín 9:16, split hình vuông cho nửa trên
  if (model.includes('hailuo')) {
    body.duration = dur > 7 ? '10' : '6';   // Hailuo std: 6s|10s (CHỈ ngang 16:9)
  } else if (model.includes('wan')) {
    body.aspect_ratio = aspect; body.resolution = '720p';
    body.num_frames = Math.min(161, Math.max(17, Math.round(dur * 16) + 1));   // ~16fps, cap 161
  } else {
    body.aspect_ratio = aspect;   // model khác hỗ trợ aspect_ratio
  }
  const sub = await fetch(`https://queue.fal.run/${model}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  if (!sub.ok) throw new Error(`fal submit ${sub.status}: ${(await sub.text()).slice(0, 200)}`);
  const q = await sub.json();
  const statusUrl = q.status_url, responseUrl = q.response_url;
  if (!statusUrl) throw new Error('fal: thiếu status_url');
  for (let i = 0; i < 150; i++) {   // poll tối đa ~5 phút
    await sleep(2000);
    const st = await fetch(statusUrl, { headers: H }).then((r) => r.json()).catch(() => ({}));
    if (st.status === 'COMPLETED') break;
    if (st.status === 'FAILED' || st.status === 'ERROR') throw new Error('fal video FAILED');
    if (i % 5 === 0) console.log(`  … ${st.status || 'IN_QUEUE'}`);
  }
  const out = await fetch(responseUrl, { headers: H }).then((r) => r.json());
  const url = out.video?.url || out.videos?.[0]?.url;
  if (!url) throw new Error('fal video: không có url trả về');
  return { url, ext: 'mp4' };
}

const srcDir = join(projDir, 'assets', 'src');
mkdirSync(srcDir, { recursive: true });
const id = 'scene-' + String(idx).padStart(2, '0');

const r = await (kind === 'image' ? genImage() : genVideo());
console.log('Tải kết quả:', r.url.slice(0, 90));
const buf = Buffer.from(await (await fetch(r.url)).arrayBuffer());
for (const f of readdirSync(srcDir)) if (f.startsWith(id + '.')) { try { rmSync(join(srcDir, f)); } catch {} }
const outP = join(srcDir, `${id}.${r.ext}`);
writeFileSync(outP, buf);
console.log(`Đã lưu ${outP} (${(buf.length / 1024).toFixed(0)} KB)`);

console.log('Cắt + crop theo scene…');
execFileSync('node', [join(__dirname, 'cut-sources.mjs'), projDir, String(idx)], { stdio: 'inherit' });
console.log('AI_SOURCE_DONE');

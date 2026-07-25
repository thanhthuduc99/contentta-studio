#!/usr/bin/env node
// Contentta Vertical Pro — app điều khiển edit video DỌC NÂNG CAO (style Nate Herk).
// Vanilla Node http + SSE (KHÔNG ws/express — không deps mới). Port 3100, độc lập app cũ.
//
// Luồng 3 stage (human-in-loop):
//   A /api/adv/plan     : upload face + yt/github/notes -> agent transcribe + plan-scenes -> plan.json (+ link tìm source)
//   B /api/adv/source   : kéo-thả source cho từng scene -> projects/<slug>/assets/src/<sceneId>.<ext>
//   C /api/adv/assemble : agent cắt source + dựng index + render + QA -> renders/final.mp4

import http from 'node:http';
import os from 'node:os';
import { readFile, mkdir, stat, readdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { createWriteStream, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, basename } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = __dirname;                                   // apps/vertical-pro
const PUBLIC = join(APP, 'public');
const UPLOADS = join(APP, 'uploads');
const PROJECTS = join(APP, 'projects');
const SCRIPTS = join(APP, 'scripts');
const EDIT_AGENT = join(APP, '..', '..');                // edit-agent workspace root
const SHORTS = join(EDIT_AGENT, 'contentta-shorts-skill'); // transcribe/build-cuts/pixabay + music
const SCRIPTDOCS = join(APP, 'scriptdocs');               // Mục 1: script AI đã sinh

// nạp .env ở gốc edit-agent vào process.env (không ghi đè biến sẵn có) — không cần dotenv.
// Cần cho AUTH_* (đăng nhập) + FAL_KEY (tạo source AI), truyền xuống script con qua spawn.
(function loadEnv() {
  try {
    for (const line of readFileSync(join(EDIT_AGENT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {}
})();

const PORT = Number(process.env.PORT || 3100);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// ---- SSE log bus -----------------------------------------------------------
const clients = new Set();
function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function broadcast(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch {} }
}
const log = (line, level = 'info') => broadcast({ type: 'log', level, line, t: stamp() });

// ---- headless Claude agent runner (prompt qua stdin, parse stream-json) -----
let running = false;   // (legacy) chỉ runAgent dùng — runAgent hiện không được gọi
// Nhiều job chạy SONG SONG; chỉ chặn khi trùng tài nguyên:
//   khoá `${slug}#${idx}` = 1 cảnh; `${slug}#*` = cả dự án (đè lên mọi cảnh của dự án đó).
const active = new Set();
function lockBusy(lock) {
  if (!lock) return false;
  const [sl, part] = lock.split('#');
  for (const a of active) {
    const [asl, apart] = a.split('#');
    if (asl !== sl) continue;
    if (part === '*' || apart === '*' || part === apart) return true;   // '*' đè lên mọi cảnh cùng dự án
  }
  return false;
}
function summarizeTool(name, input) {
  if (!input) return '';
  if (name === 'Bash') return (input.command || '').replace(/\s+/g, ' ').slice(0, 140);
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name)) return basename(input.file_path || '');
  return '';
}
function logAgentEvent(obj) {
  if (obj.type === 'assistant' && obj.message?.content) {
    for (const c of obj.message.content) {
      if (c.type === 'text' && c.text?.trim()) log(c.text.trim().slice(0, 600), 'info');
      else if (c.type === 'tool_use') { const d = summarizeTool(c.name, c.input); log(`🔧 ${c.name}${d ? ' · ' + d : ''}`, 'dim'); }
    }
  } else if (obj.type === 'result') {
    if (obj.subtype && obj.subtype !== 'success') log(`Agent kết thúc: ${obj.subtype}`, 'warn');
    if (typeof obj.result === 'string' && obj.result.trim()) log(obj.result.trim().slice(0, 800), 'info');
    const cost = obj.total_cost_usd != null ? ` · $${obj.total_cost_usd.toFixed(3)}` : '';
    log(`Agent xong${cost}`, 'success');
  }
}
function runAgent(name, prompt, cwd) {
  return new Promise((resolve) => {
    if (running) { log(`Một job đang chạy, bỏ qua "${name}".`, 'warn'); return resolve(false); }
    running = true;
    broadcast({ type: 'job', state: 'start', name });
    log(`▶ ${name}`, 'step');
    log('$ claude -p (headless agent)', 'cmd');
    const args = ['-p', '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose', '--add-dir', `"${EDIT_AGENT}"`];
    const child = spawn('claude', args, { cwd, shell: process.platform === 'win32', env: process.env });
    child.stdin.write(prompt); child.stdin.end();
    let buf = '';
    child.stdout.on('data', (b) => {
      buf += b.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) { if (!l.trim()) continue; try { logAgentEvent(JSON.parse(l)); } catch { log(l.slice(0, 600), 'dim'); } }
    });
    child.stderr.on('data', (b) => { const s = b.toString().trim(); if (s) log(s.slice(0, 600), 'dim'); });
    child.on('error', (e) => log(`Lỗi spawn claude: ${e.message}`, 'error'));
    child.on('close', (code) => {
      running = false;
      const ok = code === 0;
      broadcast({ type: 'job', state: ok ? 'done' : 'fail', name, code });
      log(ok ? `✓ ${name} xong` : `✗ ${name} fail (exit ${code})`, ok ? 'success' : 'error');
      resolve(ok);
    });
  });
}

// ---- deterministic job runner (stream stdout/stderr) -----------------------
function runJob(name, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const lock = opts.lock || `misc#${Date.now()}`;   // route đã kiểm lockBusy trước khi gọi
    active.add(lock);
    broadcast({ type: 'job', state: 'start', name, lock });
    log(`▶ ${name}`, 'step');
    // shell:false — tránh path có dấu cách ("6. AI Agent") bị tách arg trên Windows.
    // 'node'/ffmpeg/python resolve được không cần shell.
    const child = spawn(cmd, args, { cwd: opts.cwd, shell: false, env: { ...process.env, ...opts.env } });
    let buf = '';
    const onData = (b, level) => { buf += b.toString(); const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) if (l.trim()) log(l.slice(0, 400), level); };
    child.stdout.on('data', (b) => onData(b, 'info'));
    child.stderr.on('data', (b) => onData(b, 'dim'));
    child.on('error', (e) => log(`Lỗi spawn: ${e.message}`, 'error'));
    child.on('close', (code) => {
      if (buf.trim()) log(buf.slice(0, 400), 'info');
      active.delete(lock);
      const ok = code === 0;
      broadcast({ type: 'job', state: ok ? 'done' : 'fail', name, lock, code });
      log(ok ? `✓ ${name}` : `✗ ${name} fail (exit ${code})`, ok ? 'success' : 'error');
      resolve(ok);
    });
  });
}
// Auto-edit (deterministic, KHÔNG render) — chỉ cắt + plan + ảnh đại diện scene.
async function runAutoEdit(slug, src) {
  const projDir = join(PROJECTS, slug);
  await runJob(`tạo dự án → ${slug}`, 'node', [join(SCRIPTS, 'auto-edit.mjs'), projDir, src], { cwd: APP, lock: `${slug}#*` });
}
// Cắt 1 scene sau khi user thả source (cut-sources tự sinh luôn preview frame).
async function runCutScene(slug, sceneIdx) {
  await runJob(`cắt scene ${sceneIdx} → ${slug}`, 'node', [join(SCRIPTS, 'cut-sources.mjs'), join(PROJECTS, slug), String(sceneIdx)], { cwd: APP, lock: `${slug}#${sceneIdx}` });
}
// Xuất video: ffmpeg thuần — overlay b-roll + burn captions.ass + nhạc (KHÔNG Chrome).
async function runExport(slug) {
  await runJob(`xuất video → ${slug}`, 'node', [join(SCRIPTS, 'assemble-ffmpeg.mjs'), join(PROJECTS, slug)], { cwd: APP, lock: `${slug}#*` });
}
// Mục 1: sinh script (Sonnet headless — việc nhẹ).
async function runGenScript(slug, topic, notes) {
  const args = [join(SCRIPTS, 'gen-script.mjs'), join(SCRIPTDOCS, `${slug}.json`), '--topic', topic];
  if (notes) args.push('--notes', notes);
  await runJob(`viết kịch bản → ${slug}`, 'node', args, { cwd: APP, lock: `script#${slug}` });
}
// gợi ý b-roll YouTube (metadata, không tải) — quiet, KHÔNG running lock
function ytSuggest(slug, idx, q) {
  return new Promise((resolve) => {
    const args = [join(SCRIPTS, 'yt-suggest.mjs'), join(PROJECTS, slug), String(idx)];
    if (q) args.push('--q', q);
    const c = spawn('node', args, { cwd: APP, shell: false });
    c.stdout?.on('data', () => {}); c.stderr?.on('data', () => {});
    c.on('error', () => resolve(false)); c.on('close', () => resolve(true));
  });
}
async function ytPick(slug, idx, id) {
  await runJob(`b-roll YouTube → scene ${idx} (${slug})`, 'node', [join(SCRIPTS, 'yt-pick.mjs'), join(PROJECTS, slug), String(idx), id], { cwd: APP, lock: `${slug}#${idx}` });
}
// ---- settings (zoom ảnh + nhạc) + chỉnh vị trí crop ----
const MUSIC_DIR = join(APP, 'music');
const clampPct = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : d; };
// tách videoId YouTube từ url/id (cho tải-clip)
function ytVideoId(s) { s = String(s).trim(); if (/^[\w-]{11}$/.test(s)) return s; const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|\/v\/)([\w-]{11})/); return m ? m[1] : ''; }
function readSettings(slug) { try { return JSON.parse(readFileSync(join(PROJECTS, slug, 'settings.json'), 'utf8')); } catch { return { zoom: false, music: '' }; } }
async function recutAll(slug) { await runJob(`cắt lại toàn bộ → ${slug}`, 'node', [join(SCRIPTS, 'cut-sources.mjs'), join(PROJECTS, slug)], { cwd: APP, lock: `${slug}#*` }); }
// trạng thái project: 'done' nếu mọi scene type-2 có b-roll, ngược lại 'empty'.
function projectStatus(slug) {
  try {
    const plan = JSON.parse(readFileSync(join(PROJECTS, slug, 'plan.json'), 'utf8'));
    const need = plan.scenes.filter((s) => s.type === 1 || s.type === 2);   // split + full-video đều cần source
    const have = need.filter((s) => existsSync(join(PROJECTS, slug, 'assets', 'broll', `scene-${String(s.i).padStart(2, '0')}.mp4`)));
    return { status: need.length && have.length < need.length ? 'empty' : 'done', filled: have.length, need: need.length };
  } catch { return { status: 'empty', filled: 0, need: 0 }; }
}

// ---- helpers ---------------------------------------------------------------
// Liệt kê project (cho thư viện card): slug, status, thumbnail, có video xuất chưa.
async function listProjects() {
  const out = [];
  if (!existsSync(PROJECTS)) return out;
  for (const slug of await readdir(PROJECTS).catch(() => [])) {
    if (!existsSync(join(PROJECTS, slug, 'plan.json'))) continue;
    const st = projectStatus(slug);
    const thumb = existsSync(join(PROJECTS, slug, 'previews', 'scene-01.jpg')) ? `/projects/${encodeURIComponent(slug)}/previews/scene-01.jpg` : null;
    const finalMp4 = existsSync(join(PROJECTS, slug, 'renders', 'final.mp4')) ? `/projects/${encodeURIComponent(slug)}/renders/final.mp4` : null;
    let mtime = 0; try { mtime = (await stat(join(PROJECTS, slug, 'plan.json'))).mtimeMs; } catch {}
    out.push({ slug, ...st, thumb, finalMp4, mtime });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type }); res.end(data);
}
function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
}
async function serveFile(res, file) {
  try {
    const data = await readFile(file);
    const headers = { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' };
    if (/\.(html|js|css)$/i.test(file)) headers['Cache-Control'] = 'no-cache, must-revalidate';   // deploy hiện ngay, khỏi hard-reload
    res.writeHead(200, headers); res.end(data);
  } catch { send(res, 404, 'not found', 'text/plain'); }
}
function streamUpload(req, dest) {
  return new Promise((resolve, reject) => { const ws = createWriteStream(dest); req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); });
}
async function listLibrary() {
  const out = [];
  if (!existsSync(PROJECTS)) return out;
  for (const slug of await readdir(PROJECTS).catch(() => [])) {
    const rdir = join(PROJECTS, slug, 'renders');
    if (!existsSync(rdir)) continue;
    const files = (await readdir(rdir).catch(() => [])).filter((f) => f.toLowerCase().endsWith('.mp4'));
    const pick = files.find((f) => /final/i.test(f)) || files[0];
    if (!pick) continue;
    const s = await stat(join(rdir, pick));
    out.push({ slug, file: pick, size: s.size, mtime: s.mtimeMs, url: `/projects/${encodeURIComponent(slug)}/renders/${encodeURIComponent(pick)}` });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---- auth (tài khoản+mật khẩu từ .env, cookie ký HMAC) ----------------------
const AUTH_USER = (process.env.AUTH_USER || process.env.AUTH_EMAIL || '').trim();
const AUTH_USER_LC = AUTH_USER.toLowerCase();
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const AUTH_SECRET = process.env.AUTH_SECRET || 'contentta-studio-dev-secret';
const AUTH_ON = !!(AUTH_USER && AUTH_PASSWORD);   // chưa cấu hình .env -> tắt gate (khỏi tự khoá)
const sign = (payload) => createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
const eqBuf = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
function makeToken(remember) {
  const payload = `${AUTH_USER_LC}|${remember ? Date.now() + 30 * 864e5 : 0}`;   // exp 0 = cookie session
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}
function validToken(tok) {
  if (!tok || !tok.includes('.')) return false;
  const [b64, sig] = tok.split('.');
  const payload = Buffer.from(b64, 'base64url').toString();
  if (!eqBuf(sig, sign(payload))) return false;
  const [user, expStr] = payload.split('|');
  if (user !== AUTH_USER_LC) return false;
  const exp = Number(expStr);
  return !(exp && Date.now() > exp);
}
function parseCookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
  return out;
}
const isAuthed = (req) => !AUTH_ON || validToken(parseCookies(req).sp_session);

// ---- server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  try {
    // ---- auth (không cần cookie) ----
    if (path === '/api/auth/status' && req.method === 'GET') return send(res, 200, { authed: isAuthed(req), user: AUTH_USER, on: AUTH_ON });
    if (path === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const ok = AUTH_ON && (body.user || body.email || '').trim().toLowerCase() === AUTH_USER_LC && eqBuf(String(body.password || ''), AUTH_PASSWORD);
      if (!ok) return send(res, 401, { ok: false, error: 'Sai tài khoản hoặc mật khẩu' });
      const cookie = `sp_session=${makeToken(!!body.remember)}; Path=/; HttpOnly; SameSite=Lax` + (body.remember ? `; Max-Age=${30 * 86400}` : '');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': cookie });
      return res.end(JSON.stringify({ ok: true, user: AUTH_USER }));
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'sp_session=; Path=/; HttpOnly; Max-Age=0' });
      return res.end(JSON.stringify({ ok: true }));
    }
    // ---- gate: mọi API/media/SSE cần đăng nhập; chỉ vỏ tĩnh cho qua để hiện màn login ----
    const OPEN = path === '/' || path === '/app.js' || path === '/style.css' || path === '/favicon.ico';
    if (!OPEN && !isAuthed(req)) {
      if (path.startsWith('/api/')) return send(res, 401, { ok: false, error: 'auth' });
      return send(res, 403, 'forbidden', 'text/plain');
    }

    // SSE log stream
    if (path === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'log', level: 'success', line: 'Kết nối Contentta Studio', t: stamp() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (path === '/api/sp/status' && req.method === 'GET') return send(res, 200, { running: active.size > 0, jobs: [...active] });

    // MỤC 1: sinh script AI (Sonnet). POST {topic, notes} -> chạy nền, trả slug.
    if (path === '/api/sp/script' && req.method === 'POST') {
      const body = await readBody(req);
      const topic = (body.topic || '').trim().slice(0, 300);
      if (!topic) return send(res, 400, { ok: false, error: 'thiếu chủ đề' });
      await mkdir(SCRIPTDOCS, { recursive: true });
      const slug = topic.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + stamp().replace(/:/g, '');
      send(res, 200, { ok: true, slug });
      runGenScript(slug, topic, (body.notes || '').slice(0, 500));
      return;
    }
    // đọc 1 script / list scripts
    if (path === '/api/sp/script' && req.method === 'GET') {
      const slug = (url.searchParams.get('slug') || '').replace(/[^\w.\-]/g, '');
      const f = join(SCRIPTDOCS, `${slug}.json`);
      if (!existsSync(f)) return send(res, 404, { ok: false, error: 'chưa có script' });
      return send(res, 200, { ok: true, script: JSON.parse(await readFile(f, 'utf8')) });
    }
    if (path === '/api/sp/scripts' && req.method === 'GET') {
      const out = [];
      for (const f of existsSync(SCRIPTDOCS) ? await readdir(SCRIPTDOCS) : []) {
        if (!f.endsWith('.json')) continue;
        try { const j = JSON.parse(await readFile(join(SCRIPTDOCS, f), 'utf8')); out.push({ slug: f.replace(/\.json$/, ''), topic: j.topic, beats: j.beats?.length || 0, at: j.generatedAt }); } catch {}
      }
      return send(res, 200, { items: out.sort((a, b) => (b.at || '').localeCompare(a.at || '')) });
    }

    // sửa caption/text 1 scene -> plan.json + regen captions.ass
    if (path === '/api/sp/scene-text' && req.method === 'POST') {
      const body = await readBody(req);
      const slug = (body.slug || '').replace(/[^\w.\-]/g, '');
      const idx = parseInt(body.scene, 10);
      const text = (body.text || '').trim().slice(0, 500);
      const pf = join(PROJECTS, slug, 'plan.json');
      if (!slug || !idx || !text || !existsSync(pf)) return send(res, 400, { ok: false, error: 'sai slug/scene/text' });
      if (lockBusy(`${slug}#*`)) return send(res, 409, { ok: false, error: 'dự án đang xử lý, đợi xong' });
      const plan = JSON.parse(await readFile(pf, 'utf8'));
      const sc = plan.scenes.find((s) => s.i === idx);
      if (!sc) return send(res, 400, { ok: false, error: 'không thấy scene' });
      sc.text = text; sc.textEdited = true;
      await writeFile(pf, JSON.stringify(plan, null, 2));
      send(res, 200, { ok: true, scene: idx });
      runJob(`sửa caption scene ${idx} → ${slug}`, 'node', [join(SCRIPTS, 'patch-captions.mjs'), join(PROJECTS, slug)], { cwd: APP, lock: `${slug}#*` });
      return;
    }

    // đổi loại scene (1 split / 2 full / 3 face). Có broll rồi -> re-cut theo khung mới.
    if (path === '/api/sp/scene-type' && req.method === 'POST') {
      const body = await readBody(req);
      const slug = (body.slug || '').replace(/[^\w.\-]/g, '');
      const idx = parseInt(body.scene, 10);
      const type = parseInt(body.type, 10);
      const pf = join(PROJECTS, slug, 'plan.json');
      if (!slug || !idx || ![1, 2, 3].includes(type) || !existsSync(pf)) return send(res, 400, { ok: false, error: 'sai slug/scene/type' });
      if (lockBusy(`${slug}#${idx}`)) return send(res, 409, { ok: false, error: 'cảnh này đang xử lý, đợi xong' });
      const plan = JSON.parse(await readFile(pf, 'utf8'));
      const sc = plan.scenes.find((s) => s.i === idx);
      if (!sc) return send(res, 400, { ok: false, error: 'không thấy scene' });
      sc.type = type;
      await writeFile(pf, JSON.stringify(plan, null, 2));
      send(res, 200, { ok: true, scene: idx, type });
      const hasSrc = existsSync(join(PROJECTS, slug, 'assets', 'src')) && (await readdir(join(PROJECTS, slug, 'assets', 'src'))).some((f) => f.startsWith(`scene-${String(idx).padStart(2, '0')}.`));
      if (type !== 3 && hasSrc) runCutScene(slug, idx);   // re-crop theo khung mới
      else runJob(`ảnh scene ${idx} → ${slug}`, 'node', [join(SCRIPTS, 'scene-previews.mjs'), join(PROJECTS, slug), String(idx)], { cwd: APP, lock: `${slug}#${idx}` });  // D: type 3 (hoặc trống) vẫn sinh preview
      return;
    }

    // G: đổi cài đặt khung b-roll (fit/scale/pos/bg/round) -> re-cut scene
    if (path === '/api/sp/scene-bset' && req.method === 'POST') {
      const body = await readBody(req);
      const slug = (body.slug || '').replace(/[^\w.\-]/g, '');
      const idx = parseInt(body.scene, 10);
      const bset = body.bset || {};
      const pf = join(PROJECTS, slug, 'plan.json');
      if (!slug || !idx || !existsSync(pf)) return send(res, 400, { ok: false, error: 'sai slug/scene' });
      if (lockBusy(`${slug}#${idx}`)) return send(res, 409, { ok: false, error: 'cảnh này đang xử lý, đợi xong' });
      const plan = JSON.parse(await readFile(pf, 'utf8'));
      const sc = plan.scenes.find((s) => s.i === idx);
      if (!sc) return send(res, 400, { ok: false, error: 'không thấy scene' });
      sc.bset = {
        fit: 'auto',
        scale: Math.min(1.5, Math.max(0.5, +bset.scale || 1)),
        pos: ['tl', 'tc', 'tr', 'cl', 'center', 'cr', 'bl', 'bc', 'br'].includes(bset.pos) ? bset.pos : 'center',
        bg: bset.bg === 'black' ? 'black' : 'white',
        round: bset.round !== false,
        cropX: clampPct(bset.cropX, sc.bset?.cropX ?? 50),   // vị trí crop khi phủ kín
        cropY: clampPct(bset.cropY, sc.bset?.cropY ?? 50),
      };
      await writeFile(pf, JSON.stringify(plan, null, 2));
      send(res, 200, { ok: true, scene: idx });
      runCutScene(slug, idx);   // bake transform vào broll mp4
      return;
    }
    // thư viện: list project (card) + status
    if (path === '/api/sp/projects' && req.method === 'GET') return send(res, 200, { items: await listProjects() });

    // upload face video → uploads/
    if (path === '/api/sp/upload' && req.method === 'POST') {
      const name = (req.headers['x-filename'] || `face-${Date.now()}.mp4`).toString().replace(/[^\w.\-]/g, '_');
      await mkdir(UPLOADS, { recursive: true });
      const dest = join(UPLOADS, name);
      log(`⬆ Nhận face: ${name}`, 'step');
      await streamUpload(req, dest);
      const s = await stat(dest);
      log(`✓ Đã lưu ${name} (${(s.size / 1e6).toFixed(1)} MB)`, 'success');
      return send(res, 200, { ok: true, name, size: s.size });
    }

    // STAGE A: auto-edit (1 video → bản nháp). Deterministic, không agent, không link.
    if (path === '/api/sp/plan' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.faceName || '').replace(/[^\w.\-]/g, '');
      const src = join(UPLOADS, name);
      if (!name || !existsSync(src)) return send(res, 400, { ok: false, error: 'chưa thấy video đã upload' });
      const base = name.replace(/\.[^.]+$/, '').slice(0, 20).replace(/[^\w\-]/g, '');
      const slug = `nate-${base}-${stamp().replace(/:/g, '')}`;
      await mkdir(join(PROJECTS, slug), { recursive: true });
      send(res, 200, { ok: true, slug });
      runAutoEdit(slug, src);
      return;
    }

    // read plan.json (+ trạng thái source/preview mỗi scene)
    if (path === '/api/sp/plan' && req.method === 'GET') {
      const slug = (url.searchParams.get('slug') || '').replace(/[^\w.\-]/g, '');
      const pf = join(PROJECTS, slug, 'plan.json');
      if (!existsSync(pf)) return send(res, 404, { ok: false, error: 'chưa có plan' });
      const plan = JSON.parse(await readFile(pf, 'utf8'));
      const base = `/projects/${encodeURIComponent(slug)}`;
      plan.scenes = plan.scenes.map((s) => {
        const id = 'scene-' + String(s.i).padStart(2, '0');
        const hasSource = existsSync(join(PROJECTS, slug, 'assets', 'broll', `${id}.mp4`));
        const hasPrev = existsSync(join(PROJECTS, slug, 'previews', `${id}.jpg`));
        const hasTop = existsSync(join(PROJECTS, slug, 'previews', `${id}-top.jpg`));
        return {
          ...s, hasSource,
          previewUrl: hasPrev ? `${base}/previews/${id}.jpg?t=${Date.now()}` : null,
          topUrl: hasTop ? `${base}/previews/${id}-top.jpg?t=${Date.now()}` : null,
        };
      });
      return send(res, 200, { ok: true, slug, status: projectStatus(slug), plan });
    }

    // upload source cho 1 scene → cắt scene đó → trả preview để Duyệt
    if (path === '/api/sp/source' && req.method === 'POST') {
      const slug = (req.headers['x-slug'] || '').toString().replace(/[^\w.\-]/g, '');
      const scene = (req.headers['x-scene'] || '').toString().replace(/[^\w.\-]/g, '');
      const ext = (req.headers['x-ext'] || 'mp4').toString().replace(/[^\w]/g, '').slice(0, 4) || 'mp4';
      const dir = join(PROJECTS, slug, 'assets', 'src');
      const idx = parseInt(scene.replace(/\D/g, ''), 10);
      if (!slug || !scene || !existsSync(join(PROJECTS, slug))) return send(res, 400, { ok: false, error: 'slug/scene không hợp lệ' });
      if (lockBusy(`${slug}#${idx}`)) return send(res, 409, { ok: false, error: 'cảnh này đang xử lý, đợi xong' });
      await mkdir(dir, { recursive: true });
      for (const old of (await readdir(dir).catch(() => [])).filter((f) => f.startsWith(scene + '.'))) {
        try { await rm(join(dir, old)); } catch {}   // xóa source cũ (đổi video<->ảnh không bị kẹt file cũ)
      }
      const dest = join(dir, `${scene}.${ext}`);
      await streamUpload(req, dest);
      send(res, 200, { ok: true, scene, previewUrl: `/projects/${encodeURIComponent(slug)}/previews/${scene}.jpg?t=${Date.now()}` });
      runCutScene(slug, idx);   // cắt + sinh preview nền (UI poll preview khi job done)
      return;
    }

    // XUẤT VIDEO: dựng + render standard (chỉ khi đủ source)
    if (path === '/api/sp/export' && req.method === 'POST') {
      const body = await readBody(req);
      const slug = (body.slug || '').replace(/[^\w.\-]/g, '');
      if (!slug || !existsSync(join(PROJECTS, slug, 'plan.json'))) return send(res, 400, { ok: false, error: 'chưa có dự án' });
      if (lockBusy(`${slug}#*`)) return send(res, 409, { ok: false, error: 'dự án đang xử lý, đợi xong' });
      send(res, 200, { ok: true, started: slug });
      runExport(slug);
      return;
    }

    // serve project files: /projects/<slug>/...
    // gợi ý b-roll YouTube (metadata)
    if (path === '/api/sp/suggest' && req.method === 'GET') {
      const slug = (url.searchParams.get('slug') || '').replace(/[^\w.\-]/g, '');
      const scene = (url.searchParams.get('scene') || '').replace(/[^\w.\-]/g, '');
      const q = (url.searchParams.get('q') || '').slice(0, 120).trim();
      const idx = parseInt(scene.replace(/\D/g, ''), 10);
      if (!slug || !idx || !existsSync(join(PROJECTS, slug, 'plan.json'))) return send(res, 400, { ok: false, error: 'sai slug/scene' });
      const sjson = join(PROJECTS, slug, 'assets', 'cand', scene, 'suggest.json');
      let cur = null; try { cur = JSON.parse(readFileSync(sjson, 'utf8')); } catch {}
      if (!cur || (q && q !== cur.q)) await ytSuggest(slug, idx, q);
      let out = { items: [] }; try { out = JSON.parse(readFileSync(sjson, 'utf8')); } catch {}
      return send(res, 200, { ok: true, ...out });
    }
    if (path === '/api/sp/pick' && req.method === 'POST') {
      const body = await readBody(req);
      const slug = (body.slug || '').replace(/[^\w.\-]/g, '');
      const scene = (body.scene || '').replace(/[^\w.\-]/g, '');
      const id = (body.id || '').replace(/[^\w\-]/g, '');
      const idx = parseInt(scene.replace(/\D/g, ''), 10);
      if (!slug || !idx || !id) return send(res, 400, { ok: false, error: 'thiếu slug/scene/id' });
      if (lockBusy(`${slug}#${idx}`)) return send(res, 409, { ok: false, error: 'cảnh này đang xử lý' });
      send(res, 200, { ok: true, started: scene }); ytPick(slug, idx, id); return;
    }
    // tải ĐOẠN YouTube theo giây (SliceTube) → source cho scene
    if (path === '/api/sp/yt-clip' && req.method === 'POST') {
      const body = await readBody(req);
      const slug = (body.slug || '').replace(/[^\w.\-]/g, '');
      const idx = parseInt(body.scene, 10);
      const yurl = String(body.url || '').trim().slice(0, 300);
      const start = Math.max(0, Number(body.start) || 0);
      const dur = Math.min(60, Math.max(1, Number(body.dur) || 6));
      if (!slug || !idx || !yurl || !existsSync(join(PROJECTS, slug, 'plan.json'))) return send(res, 400, { ok: false, error: 'thiếu slug/scene/url' });
      if (lockBusy(`${slug}#${idx}`)) return send(res, 409, { ok: false, error: 'cảnh này đang xử lý, đợi xong' });
      send(res, 200, { ok: true, started: idx });
      runJob(`YouTube ${start}s +${dur}s → scene ${idx} (${slug})`, 'node',
        [join(SCRIPTS, 'yt-pick.mjs'), join(PROJECTS, slug), String(idx), yurl, '--start', String(start), '--dur', String(dur)], { cwd: APP, lock: `${slug}#${idx}` });
      return;
    }
    // CHỈ TẢI đoạn YouTube về máy (KHÔNG ghép scene) → stream mp4 cho trình duyệt lưu
    if (path === '/api/sp/yt-download' && req.method === 'GET') {
      const yurl = String(url.searchParams.get('url') || '').trim().slice(0, 300);
      const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
      const dur = Math.min(300, Math.max(1, Number(url.searchParams.get('dur')) || 6));
      const vid = ytVideoId(yurl);
      if (!vid) return send(res, 400, { ok: false, error: 'link YouTube không hợp lệ' });
      const dir = await mkdtemp(join(os.tmpdir(), 'ytdl-'));
      try {
        await new Promise((resolve, reject) => {
          const p = spawn('python', ['-m', 'yt_dlp',
            '-f', 'best[height<=720][ext=mp4]/best[height<=720]',
            '--download-sections', `*${start.toFixed(2)}-${(start + dur).toFixed(2)}`, '--force-keyframes-at-cuts',
            '--no-playlist', '--no-warnings', '--no-part', '-o', join(dir, 'clip.%(ext)s'),
            `https://youtu.be/${vid}`], { stdio: 'ignore' });
          const to = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('quá thời gian tải')); }, 180000);
          p.on('close', (c) => { clearTimeout(to); c === 0 ? resolve() : reject(new Error('yt-dlp lỗi (' + c + ')')); });
          p.on('error', (e) => { clearTimeout(to); reject(e); });
        });
        const f = (await readdir(dir)).find((x) => /\.(mp4|mkv|webm)$/i.test(x));
        if (!f) throw new Error('không tạo được file');
        const data = await readFile(join(dir, f));
        res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'video/mp4', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
        res.end(data);
      } catch (e) { send(res, 500, { ok: false, error: String(e.message || e).slice(0, 160) }); }
      finally { try { await rm(dir, { recursive: true, force: true }); } catch {} }
      return;
    }
    // tải ảnh/video từ Reddit (redvid.io) → source cho scene
    if (path === '/api/sp/reddit-clip' && req.method === 'POST') {
      const body = await readBody(req);
      const slug = (body.slug || '').replace(/[^\w.\-]/g, '');
      const idx = parseInt(body.scene, 10);
      const rurl = String(body.url || '').trim().slice(0, 400);
      if (!slug || !idx || !rurl || !existsSync(join(PROJECTS, slug, 'plan.json'))) return send(res, 400, { ok: false, error: 'thiếu slug/scene/url' });
      if (lockBusy(`${slug}#${idx}`)) return send(res, 409, { ok: false, error: 'cảnh này đang xử lý, đợi xong' });
      send(res, 200, { ok: true, started: idx });
      runJob(`Reddit → scene ${idx} (${slug})`, 'node',
        [join(SCRIPTS, 'reddit-source.mjs'), join(PROJECTS, slug), String(idx), rurl], { cwd: APP, lock: `${slug}#${idx}` });
      return;
    }
    // danh sách model AI (fal.ai)
    if (path === '/api/sp/ai-models' && req.method === 'GET') {
      try { return send(res, 200, JSON.parse(readFileSync(join(PUBLIC, 'ai-models.json'), 'utf8'))); } catch { return send(res, 200, { video: [], image: [] }); }
    }
    // tạo source AI (fal.ai) cho 1 scene: ảnh (FLUX) hoặc video (Hailuo)
    if (path === '/api/sp/ai-source' && req.method === 'POST') {
      const body = await readBody(req);
      const slug = (body.slug || '').replace(/[^\w.\-]/g, '');
      const idx = parseInt(body.scene, 10);
      const kind = body.kind === 'image' ? 'image' : 'video';
      const model = String(body.model || '').replace(/[^\w./\-]/g, '');
      if (!slug || !idx || !existsSync(join(PROJECTS, slug, 'plan.json'))) return send(res, 400, { ok: false, error: 'thiếu slug/scene' });
      if (lockBusy(`${slug}#${idx}`)) return send(res, 409, { ok: false, error: 'cảnh này đang xử lý, đợi xong' });
      send(res, 200, { ok: true, started: idx });
      const args = [join(SCRIPTS, 'ai-source.mjs'), join(PROJECTS, slug), String(idx), '--kind', kind];
      if (model) args.push('--model', model);
      runJob(`tạo source AI (${kind}) → scene ${idx} (${slug})`, 'node', args, { cwd: APP, lock: `${slug}#${idx}` });
      return;
    }
    // thư viện nhạc (nhãn rủi ro bản quyền)
    if (path === '/api/sp/music' && req.method === 'GET') {
      try { return send(res, 200, { items: JSON.parse(readFileSync(join(MUSIC_DIR, 'music.json'), 'utf8')) }); } catch { return send(res, 200, { items: [] }); }
    }
    // 4 style phụ đề (LUKE/HORMOZI/Ali/Umi)
    if (path === '/api/sp/sub-styles' && req.method === 'GET') {
      try { return send(res, 200, { items: JSON.parse(readFileSync(join(APP, 'public', 'sub-styles.json'), 'utf8')) }); } catch { return send(res, 200, { items: [] }); }
    }
    // render 4 ảnh xem thử style (previews/sub-<id>.jpg) — lock riêng, không chặn việc trên cảnh
    if (path === '/api/sp/sub-preview' && req.method === 'POST') {
      const body = await readBody(req);
      const slug = (body.slug || '').replace(/[^\w.\-]/g, '');
      if (!slug || !existsSync(join(PROJECTS, slug, 'plan.json'))) return send(res, 400, { ok: false, error: 'sai slug' });
      if (lockBusy(`subprev#${slug}`)) return send(res, 409, { ok: false, error: 'đang tạo preview, đợi xong' });
      send(res, 200, { ok: true, started: true });
      runJob(`xem thử phụ đề → ${slug}`, 'node', [join(SCRIPTS, 'sub-preview.mjs'), join(PROJECTS, slug)], { cwd: APP, lock: `subprev#${slug}` });
      return;
    }
    // settings: đọc / cập nhật (zoom ảnh + chọn nhạc)
    if (path === '/api/sp/settings' && req.method === 'GET') {
      const slug = (url.searchParams.get('slug') || '').replace(/[^\w.\-]/g, '');
      return send(res, 200, { ok: true, settings: readSettings(slug) });
    }
    if (path === '/api/sp/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const slug = (body.slug || '').replace(/[^\w.\-]/g, '');
      if (!slug || !existsSync(join(PROJECTS, slug))) return send(res, 400, { ok: false, error: 'sai slug' });
      const cur = readSettings(slug);
      const wantsJob = typeof body.zoom === 'boolean' || (body.sub && body.sub.preset);
      if (wantsJob && lockBusy(`${slug}#*`)) return send(res, 409, { ok: false, error: 'dự án đang xử lý, đợi xong' });
      const next = { ...cur };
      if (typeof body.zoom === 'boolean') next.zoom = body.zoom;
      if (body.music) next.music = String(body.music).replace(/[^\w.\- ]/g, '');
      if (body.sub && body.sub.preset) next.sub = { ...(cur.sub || {}), preset: String(body.sub.preset).replace(/[^\w\-]/g, '') };
      writeFileSync(join(PROJECTS, slug, 'settings.json'), JSON.stringify(next, null, 2));
      if (body.music) { const mp = join(MUSIC_DIR, next.music); if (existsSync(mp)) copyFileSync(mp, join(PROJECTS, slug, 'assets', 'music.mp3')); }
      if (typeof body.zoom === 'boolean' && body.zoom !== cur.zoom) { send(res, 200, { ok: true, recut: true }); recutAll(slug); return; }
      if (body.sub && body.sub.preset && next.sub.preset !== (cur.sub || {}).preset) {
        send(res, 200, { ok: true, restyled: true });
        runJob(`đổi style phụ đề → ${slug}`, 'node', [join(SCRIPTS, 'patch-captions.mjs'), join(PROJECTS, slug)], { cwd: APP, lock: `${slug}#*` });
        return;
      }
      return send(res, 200, { ok: true });
    }
    // chỉnh vị trí crop b-roll (cropX/cropY 0..100) → cắt lại scene đó
    if (path === '/api/sp/adjust' && req.method === 'POST') {
      const body = await readBody(req);
      const slug = (body.slug || '').replace(/[^\w.\-]/g, '');
      const scene = (body.scene || '').replace(/[^\w.\-]/g, '');
      const idx = parseInt(scene.replace(/\D/g, ''), 10);
      const pf = join(PROJECTS, slug, 'plan.json');
      if (!slug || !idx || !existsSync(pf)) return send(res, 400, { ok: false, error: 'sai slug/scene' });
      if (lockBusy(`${slug}#${idx}`)) return send(res, 409, { ok: false, error: 'cảnh này đang xử lý' });
      const plan = JSON.parse(readFileSync(pf, 'utf8'));
      const sc = plan.scenes.find((s) => s.i === idx); if (!sc) return send(res, 400, { ok: false, error: 'scene?' });
      sc.bset = { ...(sc.bset || {}), cropX: clampPct(body.cropX, 50), cropY: clampPct(body.cropY, 50) };
      writeFileSync(pf, JSON.stringify(plan, null, 2));
      send(res, 200, { ok: true }); runCutScene(slug, idx); return;
    }
    if (path.startsWith('/projects/')) {
      const rel = path.slice('/projects/'.length).split('/').map(decodeURIComponent).join('/');
      const file = join(PROJECTS, rel);
      if (!file.startsWith(PROJECTS)) return send(res, 403, 'forbidden', 'text/plain');
      return serveFile(res, file);
    }

    // static
    const file = join(PUBLIC, path === '/' ? 'index.html' : path);
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
    return serveFile(res, file);
  } catch (e) {
    log(`Server error: ${e.message}`, 'error');
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => { console.log(`\n  Contentta Vertical Pro → http://localhost:${PORT}\n`); });

// Contentta Studio — Mục 1 (kịch bản) + Mục 2 (editor kéo-thả) + thư viện dự án.
const $ = (s) => document.querySelector(s);
const sid = (i) => 'scene-' + String(i).padStart(2, '0');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TYPE_NAME = { 1: 'Split — b-roll trên, mặt dưới', 2: 'Full b-roll', 3: 'Full mặt' };

let slug = null, plan = null, cur = 0, faceFile = null;
let settleT = null;
let AI_MODELS = { video: [], image: [] };
let subStyles = [], subCur = 'luke', subPending = false;   // 4 style phụ đề + trạng thái xem thử
// job chạy SONG SONG — theo dõi qua SSE (khoá `${slug}#${idx|*}`)
let busyScenes = new Set();      // s.i đang có job (thuộc dự án đang mở)
let projectBusy = false;         // job cả-dự-án (render / zoom / caption) của dự án đang mở
let runCount = 0;                // tổng job mọi dự án -> đèn trạng thái
let needRefresh = false;
let createPend = null, scriptPend = null, exportPend = null;

// ---------------- SSE + dock nhật ký ----------------
const dock = $('#dock'), dockBody = $('#dockBody');
$('#dockToggle').addEventListener('click', () => dock.classList.toggle('open'));
function dlog(line, level) {
  $('#dockLast').textContent = line.slice(0, 80);
  const el = document.createElement('div');
  el.className = 'dock-line' + (level === 'error' ? ' err' : level === 'success' ? ' ok' : level === 'dim' ? ' dim' : '');
  el.innerHTML = `<span class="t">${new Date().toTimeString().slice(0, 8)}</span>${esc(line.slice(0, 220))}`;
  dockBody.appendChild(el);
  while (dockBody.children.length > 300) dockBody.removeChild(dockBody.firstChild);
  dockBody.scrollTop = dockBody.scrollHeight;
}
function setBusy(b) {
  $('#statusDot').classList.toggle('busy', b);
  $('#statusText').textContent = b ? 'đang chạy' : 'sẵn sàng';
  $('#dockDot').className = 'dock-dot ' + (b ? 'busy' : 'ok');
}
function loadingOn(t) { $('#loadText').textContent = t || 'Đang xử lý…'; $('#loading').classList.remove('hidden'); setBusy(true); }
function loadingOff() { $('#loading').classList.add('hidden'); setBusy(runCount > 0); }
function connect() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'log') dlog(m.line, m.level);
    if (m.type === 'job') onJob(m);
  };
  es.onerror = () => {};
}
// định tuyến 1 sự kiện job (SSE) theo khoá tài nguyên -> cập nhật trạng thái bận + hẹn refresh
function onJob(m) {
  const st = m.state, done = st !== 'start';
  runCount = st === 'start' ? runCount + 1 : Math.max(0, runCount - 1);
  setBusy(runCount > 0);
  const [lslug, part] = String(m.lock || '').split('#');
  // tạo dự án mới xong -> mở editor (create dùng overlay toàn màn hình)
  if (done && createPend && lslug === createPend) {
    const p = createPend; createPend = null; loadingOff();
    if (st === 'done') openEditor(p); else { alert('Tạo dự án thất bại — xem nhật ký.'); show('lib'); }
    return;
  }
  // sinh kịch bản xong
  if (done && scriptPend && m.lock === 'script#' + scriptPend) {
    const s = scriptPend; scriptPend = null; loadingOff();
    if (st === 'done') loadScript(s); else alert('Viết kịch bản thất bại — xem nhật ký.');
    return;
  }
  // xem thử 4 style xong (lock subprev#slug) -> vẽ lại lưới ảnh + reset nút
  if (done && lslug === 'subprev' && part === slug) {
    subPending = false;
    const b = $('#subPrevBtn'); if (b) { b.disabled = false; b.textContent = 'Xem thử trên clip'; }
    if (!$('#subModal').classList.contains('hidden')) renderSubGrid(true);
    return;
  }
  // job thuộc dự án đang mở -> đánh dấu bận + hẹn refresh (KHÔNG chặn cả app)
  if (lslug && lslug === slug) {
    if (part === '*') { projectBusy = st === 'start'; if (done) needRefresh = true; syncExportBtn(); }
    else {
      const idx = parseInt(part, 10);
      if (st === 'start') busyScenes.add(idx); else busyScenes.delete(idx);
      markSceneBusy(idx, st === 'start');
      if (done) needRefresh = true;
    }
    if (done) scheduleSettle();
  }
}
// gom nhiều job xong -> refresh nhẹ 1 lần; hoãn nếu user đang gõ/mở popover để không phá thao tác
function scheduleSettle() {
  clearTimeout(settleT);
  settleT = setTimeout(() => {
    if (!needRefresh) return;
    if (isEditingOpen()) { scheduleSettle(); return; }
    needRefresh = false;
    if (slug && !$('#viewEd').hidden) loadEditor(slug);            // giữ nguyên cur + busyScenes
    if (exportPend && exportPend === slug) { exportPend = null; setTimeout(() => showFinal(), 600); }
  }, 700);
}
function isEditingOpen() {
  // CHỈ hoãn refresh khi user đang thực sự thao tác dở dang — KHÔNG check activeElement
  // (slider/nút bên trong panel giữ focus dù panel đã ẩn → từng gây deadlock, preview không đổi).
  if (document.querySelector('.sc-editta')) return true;                    // đang sửa caption
  if (document.querySelector('.bset-panel:not([hidden])')) return true;     // popover khung mở
  if (document.querySelector('.sc-ai-panel:not([hidden])')) return true;    // popover AI mở
  return false;
}
function markSceneBusy(idx, on) {
  const el = document.querySelector('.scene-card[data-i="' + idx + '"]');
  if (!el) return;
  el.classList.toggle('busy', on);
  let ov = el.querySelector('.sc-busy');
  if (on && !ov) { ov = document.createElement('div'); ov.className = 'sc-busy'; ov.innerHTML = '<span class="spin"></span>đang xử lý…'; el.appendChild(ov); }
  else if (!on && ov) ov.remove();
}
function syncExportBtn() {
  const b = $('#btnExport'); if (!b) return;
  b.disabled = projectBusy;
  b.textContent = !projectBusy ? 'Xuất video' : (exportPend ? 'Đang xuất…' : 'Đang xử lý…');
}

// ---------------- điều hướng view ----------------
const VIEWS = { script: '#viewScript', lib: '#viewLib', ed: '#viewEd' };
function show(view) {
  for (const [k, sel] of Object.entries(VIEWS)) $(sel).hidden = k !== view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view || (view === 'ed' && t.dataset.view === 'lib')));
  if (view === 'lib') loadProjects();
  if (view === 'script') loadScriptChips();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));
$('#brandHome').addEventListener('click', () => show('lib'));
$('#btnBack').addEventListener('click', () => show('lib'));

// ================= MỤC 1: KỊCH BẢN =================
$('#btnGen').addEventListener('click', async () => {
  const topic = $('#topicInput').value.trim();
  if (!topic) { $('#topicInput').focus(); return; }
  loadingOn('Sonnet đang viết kịch bản…');
  try {
    const r = await fetch('/api/sp/script', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic, notes: $('#notesInput').value.trim() }) }).then((x) => x.json());
    if (!r.ok) throw new Error(r.error);
    scriptPend = r.slug;
  } catch (e) { loadingOff(); alert('Lỗi: ' + e.message); }
});
async function loadScript(s) {
  if (!s) return;
  try {
    const r = await fetch('/api/sp/script?slug=' + encodeURIComponent(s)).then((x) => x.json());
    if (!r.ok) return;
    renderScript(r.script); loadScriptChips();
  } catch {}
}
function renderScript(sc) {
  $('#scriptResult').hidden = false;
  $('#srTopic').textContent = sc.topic || '';
  const beats = sc.beats || [];
  $('#beatList').innerHTML = beats.map((b, i) => {
    const br = b.broll || { type: 'none' };
    const cls = br.type === 'none' ? 'none' : br.type;
    const tag = br.type === 'none' ? 'mặt' : br.n;
    const note = br.type === 'none' ? `<span class="beat-note">(${esc(br.note || 'chỉ mặt nói')})</span>` : '';
    return `<li style="animation-delay:${i * 0.05}s"><span class="beat-n ${cls}">${esc(tag)}</span><div><div class="beat-t">${esc(b.text)}</div>${note}</div></li>`;
  }).join('');
  const secs = (t) => Math.max(2, Math.round((String(t).trim().split(/\s+/).length) / 2.5));  // ~2.5 từ/giây
  const shots = beats.filter((b) => b.broll && b.broll.type !== 'none');
  $('#shotList').innerHTML = shots.length
    ? shots.map((b) => `<li><span class="beat-n ${b.broll.type}">${esc(b.broll.n)}</span><div><b>${b.broll.type === 'split' ? 'Split' : 'Full'}</b> · ~${secs(b.text)}s — ${esc(b.broll.desc || '')}</div></li>`).join('')
    : '<li class="empty-note">Script này không cần b-roll.</li>';
  $('#btnCopyScript').onclick = () => {
    const txt = beats.map((b) => `${b.broll?.n ? '[' + b.broll.n + '] ' : ''}${b.text}`).join('\n');
    navigator.clipboard.writeText(txt); $('#btnCopyScript').textContent = 'Đã copy'; setTimeout(() => ($('#btnCopyScript').textContent = 'Copy script'), 1400);
  };
  $('#scriptResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function loadScriptChips() {
  try {
    const { items } = await fetch('/api/sp/scripts').then((x) => x.json());
    $('#scriptChips').innerHTML = items.length
      ? items.map((it) => `<button class="chip" data-s="${esc(it.slug)}" type="button">${esc(it.topic || it.slug)} · ${it.beats} beats</button>`).join('')
      : '<div class="empty-note">Chưa có kịch bản nào.</div>';
    document.querySelectorAll('#scriptChips .chip').forEach((c) => c.addEventListener('click', () => loadScript(c.dataset.s)));
  } catch {}
}

// ================= MỤC 2: TẠO DỰ ÁN =================
const dz = $('#dz'), faceInput = $('#faceInput');
dz.addEventListener('click', (e) => { if (e.target.id !== 'btnCreate') faceInput.click(); });
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) setFace(e.dataTransfer.files[0]); });
faceInput.addEventListener('change', () => faceInput.files[0] && setFace(faceInput.files[0]));
function setFace(f) { faceFile = f; dz.classList.add('set'); $('#dzText').textContent = `${f.name} · ${(f.size / 1e6).toFixed(1)} MB`; $('#btnCreate').disabled = false; }
$('#btnCreate').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!faceFile) return;
  $('#btnCreate').disabled = true; loadingOn('Đang tải video + dựng cảnh…');
  try {
    const up = await fetch('/api/sp/upload', { method: 'POST', headers: { 'x-filename': faceFile.name }, body: faceFile }).then((r) => r.json());
    if (!up.ok) throw new Error(up.error);
    const r = await fetch('/api/sp/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ faceName: up.name }) }).then((x) => x.json());
    if (!r.ok) throw new Error(r.error);
    createPend = r.slug;
    faceFile = null; dz.classList.remove('set'); $('#dzText').textContent = 'Kéo-thả video quay chính (ngang 16:9) vào đây';
  } catch (e2) { loadingOff(); alert('Lỗi: ' + e2.message); $('#btnCreate').disabled = false; }
});

async function loadProjects() {
  const grid = $('#projGrid');
  try {
    const data = await fetch('/api/sp/projects').then((x) => x.json());
    const items = (data && data.items) || [];   // 401/hiccup -> [] (fetch wrapper lo màn login), không crash
    if (!items.length) { grid.innerHTML = '<div class="empty-note">Chưa có dự án nào — thả video đầu tiên vào ô trên.</div>'; return; }
    grid.innerHTML = '';
    items.forEach((it, i) => {
      const el = document.createElement('div'); el.className = 'pcard'; el.style.animationDelay = `${i * 0.05}s`;
      el.innerHTML = `${it.thumb ? `<img class="pthumb" src="${it.thumb}">` : '<div class="pthumb"></div>'}
        <div class="pmeta"><div class="pname">${esc(it.slug)}</div>
        <span class="pill ${it.status === 'done' ? 'done' : 'empty'}">${it.status === 'done' ? 'đủ b-roll' : `b-roll ${it.filled}/${it.need}`}</span>
        ${it.finalMp4 ? '<span class="pill done">đã xuất</span>' : ''}</div>`;
      el.addEventListener('click', () => openEditor(it.slug));
      grid.appendChild(el);
    });
  } catch (e) { grid.innerHTML = `<div class="empty-note">Lỗi: ${esc(e.message)}</div>`; }
}

// ================= EDITOR =================
function openEditor(s) { slug = s; cur = 0; exportPend = null; show('ed'); loadEditor(s); }
async function loadEditor(s) {
  try {
    const r = await fetch('/api/sp/plan?slug=' + encodeURIComponent(s)).then((x) => x.json());
    if (!r.ok) return;
    plan = r.plan; slug = s;
    $('#edName').textContent = s;
    const st = r.status || { filled: 0, need: 0 };
    $('#edStatus').className = 'pill ' + (st.status === 'done' ? 'done' : 'empty');
    $('#edStatus').textContent = st.status === 'done' ? 'đủ b-roll' : `b-roll ${st.filled}/${st.need}`;
    if (cur >= plan.scenes.length) cur = 0;
    await hydrateBusy(s);   // job nền của dự án này đang chạy? -> hiện badge bận
    renderStage(); renderRail(); showFinal(true); loadTools(); syncExportBtn(); ytPopulateScenes();
  } catch {}
}
// dựng lại busyScenes/projectBusy từ danh sách job đang chạy trên server (khi mở/refresh 1 dự án)
async function hydrateBusy(s) {
  busyScenes = new Set(); projectBusy = false;
  try {
    const jobs = (await fetch('/api/sp/status').then((x) => x.json())).jobs || [];
    for (const lk of jobs) { const [sl, pt] = String(lk).split('#'); if (sl !== s) continue; if (pt === '*') projectBusy = true; else busyScenes.add(parseInt(pt, 10)); }
  } catch {}
}
// zoom ảnh + chọn nhạc (project-level)
async function loadTools() {
  try {
    const [st, mu, am, ss] = await Promise.all([
      fetch('/api/sp/settings?slug=' + encodeURIComponent(slug)).then((x) => x.json()),
      fetch('/api/sp/music').then((x) => x.json()),
      fetch('/api/sp/ai-models').then((x) => x.json()).catch(() => null),
      fetch('/api/sp/sub-styles').then((x) => x.json()).catch(() => null),
    ]);
    if (am && am.video) AI_MODELS = am;
    if (ss && ss.items) subStyles = ss.items;
    const cfg = st.settings || { zoom: false, music: '' };
    subCur = (cfg.sub || {}).preset || 'luke';
    const scn = $('#subCurName'); if (scn) scn.textContent = (subStyles.find((s) => s.id === subCur) || {}).name || subCur;
    if ($('#zoomToggle')) $('#zoomToggle').checked = cfg.zoom === true;
    const sel = $('#musicSel'); if (sel) {
      sel.innerHTML = '';
      (mu.items || []).forEach((m) => {
        const o = document.createElement('option'); o.value = m.file;
        const tag = m.risk === 'safe' ? '🟢' : m.risk === 'high' ? '🔴' : '🟡';
        o.textContent = `${tag} ${m.name}`; o.dataset.risk = m.risk; o.dataset.note = m.note || '';
        if (m.file === cfg.music) o.selected = true;
        sel.appendChild(o);
      });
    }
  } catch {}
}
{
  const zt = $('#zoomToggle'), ms = $('#musicSel');
  if (zt) zt.addEventListener('change', async () => {
    try {
      const r = await fetch('/api/sp/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, zoom: zt.checked }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error);
      // r.recut -> cắt lại toàn bộ chạy nền; SSE (`${slug}#*`) sẽ refresh
    } catch (e) { zt.checked = !zt.checked; alert('Lỗi: ' + e.message); }
  });
  if (ms) ms.addEventListener('change', async () => {
    const opt = ms.selectedOptions[0];
    if (opt?.dataset.risk === 'high' && !confirm(`⚠ ${opt.textContent}\n${opt.dataset.note}\n\nVẫn dùng?`)) { loadTools(); return; }
    try {
      const r = await fetch('/api/sp/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, music: ms.value }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error);
    } catch (e) { alert('Lỗi nhạc: ' + e.message); }
  });
}
// ---------------- Phụ đề: 4 style + xem thử trên clip ----------------
function subImgUrl(id, bust) { return `/projects/${encodeURIComponent(slug)}/previews/sub-${id}.jpg` + (bust ? `?t=${Date.now()}` : ''); }
function renderSubGrid(bust) {
  const g = $('#subGrid'); if (!g) return;
  g.innerHTML = '';
  (subStyles.length ? subStyles : [{ id: 'luke', name: 'LUKE' }]).forEach((s) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'sub-item' + (s.id === subCur ? ' on' : '');
    const img = document.createElement('img');
    img.alt = s.name; img.loading = 'lazy';
    img.onerror = () => { card.classList.add('noimg'); };
    img.src = subImgUrl(s.id, bust);
    const cap = document.createElement('span'); cap.className = 'sub-name'; cap.textContent = s.name;
    card.append(img, cap);
    card.addEventListener('click', () => applySubPreset(s.id));
    g.appendChild(card);
  });
}
function openSubModal() { renderSubGrid(true); $('#subModal').classList.remove('hidden'); }
function closeSubModal() { $('#subModal').classList.add('hidden'); }
async function requestSubPreview() {
  const btn = $('#subPrevBtn'); if (subPending || !slug) return;
  subPending = true; btn.disabled = true; btn.textContent = 'Đang render…';
  try {
    const r = await fetch('/api/sp/sub-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) }).then((x) => x.json());
    if (!r.ok) throw new Error(r.error);   // SSE subprev#slug xong -> onJob vẽ lại + reset nút
  } catch (e) { subPending = false; btn.disabled = false; btn.textContent = 'Xem thử trên clip'; alert('Lỗi: ' + e.message); }
}
async function applySubPreset(id) {
  if (id === subCur) return;
  subCur = id; renderSubGrid(false);
  const scn = $('#subCurName'); if (scn) scn.textContent = (subStyles.find((s) => s.id === id) || {}).name || id;
  try {
    const r = await fetch('/api/sp/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, sub: { preset: id } }) }).then((x) => x.json());
    if (!r.ok) throw new Error(r.error);   // r.restyled -> regen captions.ass chạy nền
  } catch (e) { alert('Lỗi: ' + e.message); }
}
{
  const sb = $('#subBtn'); if (sb) sb.addEventListener('click', openSubModal);
  const sx = $('#subClose'); if (sx) sx.addEventListener('click', closeSubModal);
  const sp = $('#subPrevBtn'); if (sp) sp.addEventListener('click', requestSubPreview);
  const sm = $('#subModal'); if (sm) sm.addEventListener('click', (e) => { if (e.target === sm) closeSubModal(); });
}
function showFinal(quiet) {
  const u = `/projects/${encodeURIComponent(slug)}/renders/final.mp4`;
  fetch(u, { method: 'HEAD' }).then((r) => {
    if (!r.ok) { $('#finalBox').hidden = true; return; }
    $('#finalBox').hidden = false;
    const v = $('#finalVideo');
    const src = u + '?t=' + Date.now();
    if (!quiet || !v.src) v.src = src;
    if (!quiet) $('#finalBox').scrollIntoView({ behavior: 'smooth' });
  }).catch(() => {});
}

function renderStage() {
  const s = plan.scenes[cur], stage = $('#stage');
  let html = '';
  if (s.type === 3) {
    html = s.previewUrl ? `<img src="${s.previewUrl}">` : '<div class="sc-empty"><div class="big">Mặt nói</div></div>';
  } else if (s.type === 2) {
    html = s.hasSource && s.previewUrl ? `<img src="${s.previewUrl}">`
      : '<div class="sc-empty"><div class="big">Cảnh trống</div><span>kéo b-roll vào card bên phải</span></div>';
  } else {
    const top = s.hasSource && s.topUrl ? `<img class="sc-split-top" src="${s.topUrl}">` : '<div class="sc-empty-top">b-roll (kéo vào card)</div>';
    const bot = s.previewUrl ? `<img class="sc-split-bot" src="${s.previewUrl}">` : '';
    html = top + bot;
  }
  stage.innerHTML = html;
  $('#sceneMeta').innerHTML = `<span class="st">Cảnh ${cur + 1}/${plan.scenes.length} · ${TYPE_NAME[s.type]}</span> · ${s.dur}s<br>${esc(s.text)}`;
  $('#navPrev').disabled = cur === 0;
  $('#navNext').disabled = cur === plan.scenes.length - 1;
}
$('#navPrev').addEventListener('click', () => { if (cur > 0) { cur--; renderStage(); markActive(); } });
$('#navNext').addEventListener('click', () => { if (cur < plan.scenes.length - 1) { cur++; renderStage(); markActive(); } });
function markActive() {
  document.querySelectorAll('.scene-card').forEach((el, i) => el.classList.toggle('active', i === cur));
  const el = document.querySelectorAll('.scene-card')[cur];
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderRail() {
  const rail = $('#rail'); rail.innerHTML = '';
  plan.scenes.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'scene-card' + (i === cur ? ' active' : '');
    el.dataset.i = s.i;
    el.style.animationDelay = `${Math.min(i * 0.04, 0.4)}s`;
    // thumbnail: split có b-roll → ghép 2 nửa (trên topUrl, dưới mặt); còn lại 1 ảnh
    let thumb;
    if (s.type === 1 && s.hasSource && s.topUrl) {
      thumb = `<div class="sc-thumb sc-thumb-split"><img src="${s.topUrl}">${s.previewUrl ? `<img src="${s.previewUrl}">` : '<span></span>'}</div>`;
    } else if (s.type === 1 && !s.hasSource) {
      thumb = `<div class="sc-thumb sc-thumb-split"><span class="dark"></span>${s.previewUrl ? `<img src="${s.previewUrl}">` : '<span></span>'}</div>`;
    } else if (s.type === 2 && !s.hasSource) {
      thumb = '<div class="sc-thumb dark"></div>';
    } else {
      thumb = s.previewUrl ? `<img class="sc-thumb" src="${s.previewUrl}">` : '<div class="sc-thumb"></div>';
    }
    const seg = `<span class="seg" data-i="${s.i}">
        <button type="button" data-t="1" class="${s.type === 1 ? 'on' : ''}">Split</button>
        <button type="button" data-t="2" class="${s.type === 2 ? 'on' : ''}">Full</button>
        <button type="button" data-t="3" class="${s.type === 3 ? 'on' : ''}">Mặt</button></span>`;
    const needS = Math.max(1, Math.ceil(s.dur));   // số giây tối thiểu của clip
    let media = '';
    if (s.type === 3) media = '<div class="sc-facenote">chỉ mặt nói — không cần b-roll</div>';
    else if (s.hasSource) media = `<div class="sc-have">Đã có b-roll (${s.type === 1 ? 'nửa trên' : 'full'}) <button class="btn ghost sm" data-act="recut" type="button">Đổi video</button></div>
        ${bsetControls(s)}
        <div class="sc-drophint">kéo video/ảnh khác vào để đổi</div>`;
    else media = `<div class="sc-drop" data-i="${s.i}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 16V8m0 0-3 3m3-3 3 3"/><path d="M4 17v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1"/></svg>
        Kéo-thả b-roll (ngang/dọc/vuông) · cần clip ≥ ${needS}s · hoặc bấm chọn</div>`;
    if (s.type === 1 || s.type === 2) media += aiControls(s);
    el.innerHTML = `${thumb}<div class="sc-body">
        <div class="sc-row1"><span class="sc-idx">Cảnh ${s.i}</span><span class="sc-dur">${s.dur}s</span>${seg}</div>
        <div class="sc-textrow"><div class="sc-text" title="bấm bút để sửa caption">${esc(s.text)}</div>
          <button class="sc-editbtn" data-act="edit" type="button" title="Sửa caption">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </button></div>${media}</div>`;
    el.addEventListener('click', () => { cur = i; renderStage(); markActive(); });
    // segmented đổi loại
    el.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const type = parseInt(b.dataset.t, 10);
      if (type === s.type) return;
      el.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));   // highlight ngay
      busyScenes.add(s.i); markSceneBusy(s.i, true);
      try {
        const r = await fetch('/api/sp/scene-type', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, scene: s.i, type }) }).then((x) => x.json());
        if (!r.ok) throw new Error(r.error);   // job (cắt/preview) chạy nền -> SSE refresh
      } catch (e2) { busyScenes.delete(s.i); markSceneBusy(s.i, false); alert('Lỗi: ' + e2.message); }
    }));
    // dropzone
    const drop = el.querySelector('.sc-drop');
    if (drop) {
      drop.addEventListener('click', (e) => { e.stopPropagation(); pickSource(s); });
      drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('drag'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) uploadSource(s, e.dataTransfer.files[0]); });
    }
    const recut = el.querySelector('[data-act="recut"]');
    if (recut) recut.addEventListener('click', (e) => { e.stopPropagation(); pickSource(s); });
    // C: kéo video/ảnh khác vào CẢ CARD (kể cả đã có b-roll) → đổi luôn
    if (s.type === 1 || s.type === 2) {
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('card-drag'); });
      el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('card-drag'); });
      el.addEventListener('drop', (e) => {
        if (!e.dataTransfer.files[0]) return;
        e.preventDefault(); e.stopPropagation(); el.classList.remove('card-drag');
        cur = i; uploadSource(s, e.dataTransfer.files[0]);
      });
    }
    // G: điều khiển chỉnh khung b-roll (bg / bo góc / scale / 9 vị trí)
    wireBset(el, s);
    wireAi(el, s);
    if (busyScenes.has(s.i)) {   // job nền đang chạy trên cảnh này -> overlay bận (el chưa vào DOM nên gắn trực tiếp)
      el.classList.add('busy');
      const ov = document.createElement('div'); ov.className = 'sc-busy'; ov.innerHTML = '<span class="spin"></span>đang xử lý…'; el.appendChild(ov);
    }
    // sửa caption inline
    el.querySelector('[data-act="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const row = el.querySelector('.sc-textrow');
      row.innerHTML = `<textarea class="sc-editta">${esc(s.text)}</textarea>
        <div class="sc-editact"><button class="btn primary sm" data-act="save" type="button">Lưu</button>
        <button class="btn ghost sm" data-act="cancel" type="button">Hủy</button></div>`;
      const ta = row.querySelector('.sc-editta'); ta.focus();
      ta.addEventListener('click', (ev) => ev.stopPropagation());
      row.querySelector('[data-act="cancel"]').addEventListener('click', (ev) => { ev.stopPropagation(); renderRail(); markActive(); });
      const saveBtn = row.querySelector('[data-act="save"]');
      saveBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const text = ta.value.trim();
        if (!text || text === s.text) { renderRail(); markActive(); return; }
        saveBtn.disabled = true; saveBtn.textContent = 'Đang lưu…';
        try {
          const r = await fetch('/api/sp/scene-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, scene: s.i, text }) }).then((x) => x.json());
          if (!r.ok) throw new Error(r.error);
          // server đã ghi plan.json đồng bộ -> cập nhật lạc quan + đóng editor NGAY (regen .ass chạy nền)
          s.text = text; renderRail(); markActive();
        } catch (e2) { saveBtn.disabled = false; saveBtn.textContent = 'Lưu'; alert('Lỗi: ' + e2.message); }
      });
    });
    rail.appendChild(el);
  });
}

// ---- G: chỉnh khung b-roll (bg / bo góc / scale / 9 vị trí) ----
const POS = [['tl', '↖'], ['tc', '↑'], ['tr', '↗'], ['cl', '←'], ['center', '•'], ['cr', '→'], ['bl', '↙'], ['bc', '↓'], ['br', '↘']];
function defBset() { return { fit: 'auto', scale: 1.0, pos: 'center', bg: 'white', round: true, cropX: 50, cropY: 50 }; }
// lưới 9 vị trí -> cropX/cropY preset (đồng thời là 'pos' cho fit-mode)
const POS_CROP = { tl: [0, 0], tc: [50, 0], tr: [100, 0], cl: [0, 50], center: [50, 50], cr: [100, 50], bl: [0, 100], bc: [50, 100], br: [100, 100] };
// từ cropX/cropY hiện tại suy ra nút lưới đang chọn (khớp gần nhất)
function posFromCrop(cx, cy) {
  let best = 'center', bd = 1e9;
  for (const [k, [x, y]] of Object.entries(POS_CROP)) { const d = (x - cx) ** 2 + (y - cy) ** 2; if (d < bd) { bd = d; best = k; } }
  return best;
}
function bsetControls(s) {
  if (s.type !== 1 && s.type !== 2) return '';   // split + full-video có chỉnh vị trí; mặt thì không
  const b = { ...defBset(), ...(s.bset || {}) };
  const isFull = s.type === 2;
  const sel = b.pos && POS_CROP[b.pos] ? b.pos : posFromCrop(b.cropX, b.cropY);
  const posBtns = POS.map(([k, ic]) => `<button type="button" class="pos-b ${sel === k ? 'on' : ''}" data-pos="${k}">${ic}</button>`).join('');
  return `<div class="bset" data-i="${s.i}">
    <button class="bset-toggle" type="button">⚙ Chỉnh vị trí / khung</button>
    <div class="bset-panel" hidden>
      <div class="bset-row"><span>Vị trí</span><div class="pos-grid">${posBtns}</div></div>
      ${isFull ? `
      <div class="bset-row"><span>Nền</span><span class="seg2">
        <button type="button" data-bg="white" class="${b.bg === 'white' ? 'on' : ''}">Trắng</button>
        <button type="button" data-bg="black" class="${b.bg === 'black' ? 'on' : ''}">Đen</button></span></div>
      <div class="bset-row"><span>Bo góc</span><label class="sw"><input type="checkbox" class="round-cb" ${b.round ? 'checked' : ''}><span></span></label></div>
      <div class="bset-row"><span>Cỡ</span><input type="range" class="scale-r" min="50" max="150" step="5" value="${Math.round(b.scale * 100)}"><b class="scale-v">${Math.round(b.scale * 100)}%</b></div>` : ''}
      <button class="btn primary sm bset-apply" type="button">Áp dụng</button>
    </div></div>`;
}
function wireBset(el, s) {
  const box = el.querySelector('.bset');
  if (!box) return;
  const panel = box.querySelector('.bset-panel');
  const isFull = s.type === 2;
  box.querySelector('.bset-toggle').addEventListener('click', (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; });
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.querySelectorAll('.pos-b').forEach((b) => b.addEventListener('click', () => { panel.querySelectorAll('.pos-b').forEach((x) => x.classList.remove('on')); b.classList.add('on'); }));
  if (isFull) {
    panel.querySelectorAll('[data-bg]').forEach((b) => b.addEventListener('click', () => { panel.querySelectorAll('[data-bg]').forEach((x) => x.classList.remove('on')); b.classList.add('on'); }));
    const sr = panel.querySelector('.scale-r'), sv = panel.querySelector('.scale-v');
    sr.addEventListener('input', () => (sv.textContent = sr.value + '%'));
  }
  panel.querySelector('.bset-apply').addEventListener('click', async () => {
    const pos = panel.querySelector('.pos-b.on')?.dataset.pos || 'center';
    const [cropX, cropY] = POS_CROP[pos];
    const bset = { cropX, cropY, pos };
    if (isFull) {
      bset.fit = 'auto';
      bset.bg = panel.querySelector('[data-bg].on')?.dataset.bg || 'white';
      bset.round = panel.querySelector('.round-cb').checked;
      bset.scale = parseInt(panel.querySelector('.scale-r').value, 10) / 100;
    }
    panel.hidden = true;   // đóng popover để refresh không bị isEditingOpen chặn
    cur = plan.scenes.findIndex((x) => x.i === s.i); renderStage();   // stage lớn nhảy về cảnh đang sửa
    busyScenes.add(s.i); markSceneBusy(s.i, true);
    try {
      const r = await fetch('/api/sp/scene-bset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, scene: s.i, bset }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error);
    } catch (e) { busyScenes.delete(s.i); markSceneBusy(s.i, false); alert('Lỗi: ' + e.message); }
  });
}

// ---- tạo source AI (fal.ai) — popover trên scene-card ----
function aiControls(s) {
  return `<div class="sc-ai" data-i="${s.i}">
    <button class="sc-ai-toggle" type="button">✨ Tạo source AI</button>
    <div class="sc-ai-panel" hidden>
      <div class="sc-ai-row"><span>Loại</span><span class="seg2 ai-kind">
        <button type="button" data-k="video" class="on">Video</button>
        <button type="button" data-k="image">Ảnh</button></span></div>
      <div class="sc-ai-row"><span>Model</span><select class="ai-model"></select></div>
      <button class="btn primary sm ai-go" type="button">Tạo</button>
      <p class="sc-ai-hint">AI đọc caption, sinh b-roll khớp thời lượng cảnh. Cần FAL_KEY.</p>
    </div></div>`;
}
function wireAi(el, s) {
  const box = el.querySelector('.sc-ai'); if (!box) return;
  const panel = box.querySelector('.sc-ai-panel');
  const sel = panel.querySelector('.ai-model'), kindSeg = panel.querySelector('.ai-kind');
  let kind = 'video';
  const fillModels = () => { sel.innerHTML = ''; (AI_MODELS[kind] || []).forEach((m) => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; sel.appendChild(o); }); };
  box.querySelector('.sc-ai-toggle').addEventListener('click', (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; if (!panel.hidden) fillModels(); });
  panel.addEventListener('click', (e) => e.stopPropagation());
  kindSeg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { kindSeg.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); kind = b.dataset.k; fillModels(); }));
  panel.querySelector('.ai-go').addEventListener('click', async () => {
    const model = sel.value;
    panel.hidden = true;   // đóng popover -> cho phép refresh
    cur = plan.scenes.findIndex((x) => x.i === s.i); renderStage();
    busyScenes.add(s.i); markSceneBusy(s.i, true);
    try {
      const r = await fetch('/api/sp/ai-source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, scene: s.i, kind, model }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error);   // fal.ai chạy nền (30–90s) -> SSE refresh khi xong
    } catch (e) { busyScenes.delete(s.i); markSceneBusy(s.i, false); alert('Lỗi: ' + e.message); }
  });
}

const srcInput = $('#srcInput');
let srcTarget = null;
srcInput.addEventListener('change', () => { if (srcInput.files[0] && srcTarget) uploadSource(srcTarget, srcInput.files[0]); srcInput.value = ''; });
function pickSource(s) { srcTarget = s; srcInput.click(); }
async function uploadSource(s, file) {
  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
  cur = plan.scenes.findIndex((x) => x.i === s.i); renderStage();
  busyScenes.add(s.i); markSceneBusy(s.i, true);
  try {
    const r = await fetch('/api/sp/source', { method: 'POST', headers: { 'x-slug': slug, 'x-scene': sid(s.i), 'x-ext': ext }, body: file }).then((x) => x.json());
    if (!r.ok) throw new Error(r.error);   // upload xong -> cắt cảnh chạy nền -> SSE refresh
  } catch (e) { busyScenes.delete(s.i); markSceneBusy(s.i, false); alert('Lỗi: ' + e.message); }
}

$('#btnExport').addEventListener('click', async () => {
  exportPend = slug; projectBusy = true; syncExportBtn();
  try {
    const r = await fetch('/api/sp/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) }).then((x) => x.json());
    if (!r.ok) throw new Error(r.error);   // render chạy nền; SSE (`${slug}#*` done) -> refresh + showFinal
  } catch (e) { exportPend = null; projectBusy = false; syncExportBtn(); alert('Lỗi: ' + e.message); }
});

// ---------------- Tải clip YouTube (section riêng) ----------------
let ytPlayer = null, ytApiP = null, ytPollT = null;
function loadYTApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiP) return ytApiP;
  ytApiP = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
  });
  return ytApiP;
}
function ytId(u) { u = String(u).trim(); if (/^[\w-]{11}$/.test(u)) return u; const m = u.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/); return m ? m[1] : ''; }
function fillSceneSelect(sel) {
  if (!sel || !plan) return;
  sel.innerHTML = '';
  plan.scenes.filter((s) => s.type === 1 || s.type === 2).forEach((s) => {
    const o = document.createElement('option'); o.value = s.i; o.textContent = `Cảnh ${s.i}`;
    if (plan.scenes[cur]?.i === s.i) o.selected = true;
    sel.appendChild(o);
  });
}
function ytPopulateScenes() { fillSceneSelect($('#rdScene')); }   // YouTube giờ chỉ tải-về, Reddit vẫn gắn cảnh
const fmtS = (v) => (Math.round(v * 10) / 10).toFixed(1) + 's';
function ytSyncLen() {
  const a = parseFloat($('#ytStart').value), b = parseFloat($('#ytEnd').value);
  $('#ytStartV').textContent = fmtS(a); $('#ytEndV').textContent = fmtS(b);
  $('#ytLen').textContent = 'đoạn ' + fmtS(Math.max(0, b - a));
}
(function initYT() {
  const toggle = $('#ytSecToggle'); if (!toggle) return;
  const body = $('#ytSecBody'), st = $('#ytStart'), en = $('#ytEnd');
  toggle.addEventListener('click', () => { body.hidden = !body.hidden; toggle.classList.toggle('open', !body.hidden); if (!body.hidden) ytPopulateScenes(); });
  st.addEventListener('input', () => { if (parseFloat(st.value) > parseFloat(en.value)) en.value = st.value; ytSyncLen(); });
  en.addEventListener('input', () => { if (parseFloat(en.value) < parseFloat(st.value)) st.value = en.value; ytSyncLen(); });
  $('#ytLoad').addEventListener('click', async () => {
    const id = ytId($('#ytUrl').value);
    if (!id) { alert('Link YouTube không hợp lệ'); return; }
    await loadYTApi();
    $('#ytPlayerWrap').hidden = false;
    $('#ytPlayerHost').innerHTML = '<div id="ytPlayer"></div>';
    if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch {} }
    ytPlayer = new YT.Player('ytPlayer', { videoId: id, width: '100%', height: '240',
      events: { onReady: (e) => { const d = Math.max(1, Math.floor(e.target.getDuration()) || 60); st.max = d; en.max = d; st.value = 0; en.value = Math.min(6, d); ytSyncLen(); } } });
  });
  $('#ytSetStart').addEventListener('click', () => { if (ytPlayer) { st.value = Math.max(0, ytPlayer.getCurrentTime()); if (parseFloat(st.value) > parseFloat(en.value)) en.value = st.value; ytSyncLen(); } });
  $('#ytSetEnd').addEventListener('click', () => { if (ytPlayer) { en.value = Math.max(parseFloat(st.value) + 0.5, ytPlayer.getCurrentTime()); ytSyncLen(); } });
  $('#ytPreview').addEventListener('click', () => {
    if (!ytPlayer) return; const a = parseFloat(st.value), b = parseFloat(en.value);
    clearInterval(ytPollT); ytPlayer.seekTo(a, true); ytPlayer.playVideo();
    ytPollT = setInterval(() => { if (ytPlayer.getCurrentTime() >= b) { ytPlayer.pauseVideo(); clearInterval(ytPollT); } }, 100);
  });
  // CHỈ tải clip về máy (KHÔNG ghép vào scene) — stream mp4 rồi trình duyệt lưu file
  $('#ytDownload').addEventListener('click', async () => {
    const yurl = $('#ytUrl').value.trim();
    const id = ytId(yurl);
    if (!id) { alert('Link YouTube không hợp lệ'); return; }
    const start = parseFloat(st.value), dur = Math.max(1, parseFloat(en.value) - start);
    const btn = $('#ytDownload'), old = btn.textContent; btn.disabled = true; btn.textContent = 'Đang tải…';
    try {
      const u = `/api/sp/yt-download?url=${encodeURIComponent(yurl)}&start=${start.toFixed(2)}&dur=${dur.toFixed(2)}`;
      const r = await fetch(u);
      if (!r.ok) { let m = 'tải lỗi'; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
      const blob = await r.blob();
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `clip-${id}.mp4`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
    } catch (e) { alert('Lỗi: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = old; }
  });
  // Reddit: dán link ảnh/video -> tải về cảnh (chung section)
  const rdBtn = $('#rdDownload');
  if (rdBtn) rdBtn.addEventListener('click', async () => {
    const scene = parseInt($('#rdScene').value, 10);
    const url = $('#rdUrl').value.trim();
    if (!url || !scene) { alert('Thiếu link Reddit hoặc cảnh'); return; }
    cur = plan.scenes.findIndex((x) => x.i === scene); renderStage();
    busyScenes.add(scene); markSceneBusy(scene, true);
    try {
      const r = await fetch('/api/sp/reddit-clip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, scene, url }) }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error);   // tải Reddit chạy nền -> SSE refresh
    } catch (e) { busyScenes.delete(scene); markSceneBusy(scene, false); alert('Lỗi: ' + e.message); }
  });
})();

// ---------------- đăng nhập (gate qua .env) ----------------
function showAuthGate(user) {
  const gate = $('#authGate'); if (!gate) return;
  gate.classList.remove('hidden');
  if (user && $('#authUser')) $('#authUser').value = user;
  $('#authPass')?.focus();
}
function startApp() { $('#authGate')?.classList.add('hidden'); connect(); show('lib'); }
// bọc fetch: /api/sp/* trả 401 (hết phiên) -> hiện lại màn đăng nhập thay vì crash cryptic
const _origFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const r = await _origFetch(...args);
  try { const u = typeof args[0] === 'string' ? args[0] : args[0]?.url; if (r.status === 401 && u && u.includes('/api/sp/')) showAuthGate(); } catch {}
  return r;
};
async function boot() {
  try {
    const st = await fetch('/api/auth/status').then((r) => r.json());
    if (st.on && !st.authed) { showAuthGate(st.user); return; }
    if (st.on) $('#btnLogout').hidden = false;
  } catch {}
  startApp();
}
$('#authForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#authErr'), btn = $('#authBtn'); err.hidden = true; btn.disabled = true; btn.textContent = 'Đang vào…';
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: $('#authUser').value.trim(), password: $('#authPass').value, remember: $('#authRemember').checked }) }).then((x) => x.json());
    if (!r.ok) throw new Error(r.error || 'Đăng nhập thất bại');
    $('#btnLogout').hidden = false; startApp();
  } catch (e2) { err.textContent = e2.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Đăng nhập'; }
});
$('#btnLogout')?.addEventListener('click', async () => { try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {} location.reload(); });
boot();

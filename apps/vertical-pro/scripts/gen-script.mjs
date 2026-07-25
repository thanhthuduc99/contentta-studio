#!/usr/bin/env node
// gen-script.mjs — Mục 1: chủ đề -> script video ngắn nhịp Nate Herk + shot list b-roll đánh số.
// Gọi claude headless model SONNET (việc nhẹ). Output JSON thuần -> <out>.json.
// Usage: node gen-script.mjs <out.json> --topic "..." [--notes "..."]

import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[i + 1]; i++; } else pos.push(args[i]); }
const outPath = pos[0];
const topic = (flags.topic || '').trim();
if (!outPath || !topic) { console.error('Usage: node gen-script.mjs <out.json> --topic "..." [--notes "..."]'); process.exit(1); }

const PROMPT = `Bạn là scriptwriter video ngắn (TikTok/Reels/Shorts) cho Thành Vũ Đức — founder Contentta, làm content về AI. Viết script TIẾNG VIỆT cho chủ đề dưới đây.

CHỦ ĐỀ: ${topic}
${flags.notes ? `GHI CHÚ THÊM: ${flags.notes}` : ''}

YÊU CẦU PHONG CÁCH (học Nate Herk):
- Hook 1-2 câu đầu phải giật: con số cụ thể / kết quả bất ngờ / nghịch lý. Không mở bài vòng vo.
- Câu NGẮN. Nhịp NHANH. Mỗi beat 1 ý, nói được trong 3-6 giây.
- Tổng thời lượng đọc ~45-70 giây (khoảng 10-16 beats).
- Giọng casual nói với "bạn", số liệu cụ thể, không sáo rỗng, không emoji.
- Kết = CTA kiểu "Comment X mình gửi link".

B-ROLL: với MỖI beat, quyết định beat đó cần b-roll gì khi edit (video xuất DỌC nhưng source b-roll người quay/tìm sẽ là video NGANG):
- "split" = màn hình chia đôi: b-roll trên, mặt dưới (dùng khi minh hoạ trong lúc vẫn cần mặt)
- "full" = b-roll chiếm toàn màn hình (demo/screen recording quan trọng)
- "none" = không cần b-roll, chỉ mặt nói (hook, câu chuyển, CTA)
Đánh số b-roll liên tục B1, B2... (beat "none" không có số). "desc" = mô tả CỤ THỂ cảnh ngang cần quay/tìm (quay màn hình gì, cảnh gì) để người quay đặt tên file theo số đó.

TRẢ VỀ DUY NHẤT JSON (không markdown fence, không giải thích):
{"topic":"...","hook":"câu hook","beats":[{"i":1,"text":"câu thoại đọc","broll":{"n":"B1","type":"split","desc":"cảnh ngang cần quay"}},{"i":2,"text":"...","broll":{"type":"none","note":"chỉ mặt nói"}}],"cta":"câu CTA cuối"}`;

function extractJson(s) {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const child = spawn('claude', ['-p', '--model', 'sonnet', '--output-format', 'text'], { shell: process.platform === 'win32', env: process.env });
child.stdin.write(PROMPT); child.stdin.end();
let out = '', err = '';
child.stdout.on('data', (b) => (out += b.toString()));
child.stderr.on('data', (b) => (err += b.toString()));
child.on('close', (code) => {
  const json = extractJson(out);
  if (!json || !Array.isArray(json.beats)) {
    console.error(`GEN_SCRIPT_FAIL exit=${code} err=${err.slice(0, 200)} out=${out.slice(0, 200)}`);
    process.exit(1);
  }
  // chuẩn hoá + đánh lại số B
  let bn = 0;
  json.beats = json.beats.map((b, i) => {
    const broll = b.broll && b.broll.type && b.broll.type !== 'none'
      ? { n: `B${++bn}`, type: b.broll.type === 'split' ? 'split' : 'full', desc: b.broll.desc || '' }
      : { type: 'none', note: b.broll?.note || 'chỉ mặt nói' };
    return { i: i + 1, text: (b.text || '').trim(), broll };
  });
  json.generatedAt = new Date().toISOString();
  writeFileSync(outPath, JSON.stringify(json, null, 2));
  console.log(`GEN_SCRIPT_OK beats=${json.beats.length} brolls=${bn} -> ${outPath}`);
});

#!/usr/bin/env node
// transcribe-openai.mjs — transcribe qua OpenAI Whisper API (whisper-1), word+segment.
// Nhanh (~vài giây), không tốn CPU/RAM máy. Cần OPENAI_API_KEY trong edit-agent/.env.
//
// Usage: node transcribe-openai.mjs <audio-or-video> [out.json] [--lang vi]
// Output: OpenAI verbose_json (text, duration, words[{word,start,end}], segments[]).
//
// Lưu ý: OpenAI nhận file <=25MB. Script tự tách audio mp3 16k mono qua ffmpeg trước khi gửi.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const outArg = args.filter((a) => !a.startsWith('--'))[1];
const lang = (args.find((a) => a.startsWith('--lang')) || '--lang=vi').split('=')[1] || 'vi';
if (!input) { console.error('Usage: node transcribe-openai.mjs <audio|video> [out.json] [--lang=vi]'); process.exit(1); }

// load key from edit-agent/.env (walk up to find it)
function findEnvKey() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = join(dir, '.env');
    if (existsSync(p)) {
      const m = readFileSync(p, 'utf8').match(/OPENAI_API_KEY\s*=\s*(.+)/);
      if (m) return m[1].trim();
    }
    dir = dirname(dir);
  }
  return process.env.OPENAI_API_KEY;
}
const key = findEnvKey();
if (!key) { console.error('ERROR: OPENAI_API_KEY not found in .env'); process.exit(1); }

const out = outArg || join(dirname(input), 'transcript.json');
const tmp = join(tmpdir(), `oai-${Date.now()}.mp3`);
execFileSync('ffmpeg', ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', tmp], { stdio: 'ignore' });

const fd = new FormData();
fd.append('file', new Blob([readFileSync(tmp)]), 'audio.mp3');
fd.append('model', 'whisper-1');
fd.append('language', lang);
fd.append('response_format', 'verbose_json');
fd.append('timestamp_granularities[]', 'word');
fd.append('timestamp_granularities[]', 'segment');

const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
  method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd,
});
if (!r.ok) { console.error('ERR', r.status, await r.text()); process.exit(1); }
const j = await r.json();
writeFileSync(out, JSON.stringify(j, null, 2));
console.error(`OK words=${(j.words || []).length} segments=${(j.segments || []).length} dur=${j.duration} -> ${out}`);
console.log((j.text || '').slice(0, 300));

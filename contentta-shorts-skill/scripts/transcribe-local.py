#!/usr/bin/env python3
"""
Free local transcription via faster-whisper (offline, no OpenAI).
Outputs OpenAI-verbose_json-compatible shape so it drops into the existing
caption / cut pipeline unchanged.

Usage:
  python transcribe-local.py <input.(mp4|m4a|wav|...)> [--out transcript.json]
                             [--model small|medium|large-v3] [--lang vi]

Notes:
  - First run downloads the chosen model (cached afterwards).
  - compute_type=int8 keeps RAM low (good for constrained machines).
  - Vietnamese: prefer --model medium (better accuracy than small);
    brand/foreign words (Claude, Vercel, ...) are still best fixed via
    replacements.json in generate-captions.mjs.
"""
import sys, os, json, argparse, time

# Force UTF-8 stdout (Windows console defaults to cp1252 and chokes on Vietnamese)
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--out", default=None, help="output json path (default: <input dir>/transcript.json)")
    ap.add_argument("--model", default="medium")
    ap.add_argument("--lang", default="vi")
    ap.add_argument("--compute", default="int8")
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        print(f"ERROR: input not found: {args.input}", file=sys.stderr); sys.exit(1)
    out = args.out or os.path.join(os.path.dirname(os.path.abspath(args.input)), "transcript.json")

    from faster_whisper import WhisperModel
    t0 = time.time()
    model = WhisperModel(args.model, device="cpu", compute_type=args.compute)
    print(f"[model {args.model} loaded in {time.time()-t0:.1f}s]", file=sys.stderr)

    t1 = time.time()
    segments, info = model.transcribe(
        os.path.abspath(args.input),
        language=args.lang,
        word_timestamps=True,
        vad_filter=True,
    )

    words, segs, text = [], [], ""
    for s in segments:
        seg_text = s.text
        text += seg_text
        segs.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": seg_text.strip()})
        for w in (s.words or []):
            words.append({"word": w.word, "start": round(w.start, 3), "end": round(w.end, 3)})

    result = {
        "text": text.strip(),
        "language": info.language,
        "duration": round(info.duration, 3),
        "words": words,
        "segments": segs,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"[transcribed {info.duration:.1f}s audio in {time.time()-t1:.1f}s -> {out}]", file=sys.stderr)
    print(f"OK words={len(words)} segments={len(segs)}")
    print("TEXT:", text.strip()[:400])

if __name__ == "__main__":
    main()

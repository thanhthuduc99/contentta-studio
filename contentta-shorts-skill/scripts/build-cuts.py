#!/usr/bin/env python3
"""
build-cuts.py — cắt vấp/dead-air cho video dọc cơ bản, từ transcript word-level.

Xử lý:
  - lead-in / trailing im lặng (trim mép)
  - dead-air: gap giữa 2 từ > GAP giây -> bỏ phần im, giữ PAD quanh tiếng
  - hold/khựng: 1 "từ" Whisper kéo dài > HOLD giây = nói xong rồi im -> cap end = start+HOLD_CAP
  - (false-start "nói lại" KHÔNG tự bỏ ở đây — semantic, cần người duyệt; xem ghi chú cuối)
Rồi ffmpeg trim+concat + setpts/SPEED + atempo=SPEED -> face-final.mp4 (H.264 GOP dày).

Usage:
  python build-cuts.py <transcript.json> <source.mp4> <out.mp4>
      [--gap 0.5] [--pad 0.18] [--hold 1.0] [--holdcap 0.6] [--speed 1.1] [--dry]
      [--encoder nvenc|x264] [--remap-out assets/transcript-final.json]
--dry: chỉ in keep-ranges, không chạy ffmpeg (để duyệt trước).
--encoder nvenc (default): encode GPU h264_nvenc (RTX 4050), nhanh ~3-4x so x264.
--remap-out: ghi transcript đã remap timestamp qua phép cắt + speed -> KHỎI re-transcribe
  (words/segments shape y hệt OpenAI verbose_json; từ nào bị cắt sạch thì drop).
"""
import sys, json, argparse, subprocess, re

def _norm(word):
    return re.sub(r'\W', '', word.lower())

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript"); ap.add_argument("source"); ap.add_argument("out")
    ap.add_argument("--gap", type=float, default=0.5)
    ap.add_argument("--pad", type=float, default=0.18)
    ap.add_argument("--hold", type=float, default=1.0)
    ap.add_argument("--holdcap", type=float, default=0.6)
    ap.add_argument("--speed", type=float, default=1.1)
    ap.add_argument("--maxgap", type=float, default=0.0,
                    help="0 = bỏ hết im (aggressive). >0 = chỉ cắt khi gap > maxgap, GIỮ lại maxgap giây (vd 5 cho video show màn hình).")
    ap.add_argument("--dedup", action="store_true",
                    help="bắt lặp từ liên tiếp: cùng từ xuất hiện 2 lần trong 2s -> cắt lần đầu")
    ap.add_argument("--restart", action="store_true",
                    help="bắt take làm lại: 2 câu liền nhau mở đầu trùng >=N từ -> GIỮ câu sau, cắt câu trước (incomplete/lặp cụm)")
    ap.add_argument("--restart-minprefix", type=int, default=3,
                    help="số từ mở đầu trùng tối thiểu để coi là làm lại (default 3, hạ xuống 2 = nhạy hơn nhưng dễ nhầm)")
    ap.add_argument("--restart-maxgap", type=float, default=1.8,
                    help="khoảng cách tối đa giữa 2 take để coi là làm lại (giây)")
    ap.add_argument("--cue", default=None,
                    help='tiếng hiệu "làm lại" khi quay: gặp cụm này -> cắt NGƯỢC về đầu câu hỏng + bỏ luôn tiếng hiệu (deterministic). Vd --cue "làm lại"')
    ap.add_argument("--encoder", choices=["nvenc", "x264"], default="nvenc")
    ap.add_argument("--remap-out", default=None,
                    help="ghi transcript-final.json remap qua cắt+speed (bỏ bước re-transcribe)")
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()

    t = json.load(open(a.transcript, encoding="utf-8"))
    w = t["words"]
    def eff_end(wd):
        d = wd["end"] - wd["start"]
        return min(wd["end"], wd["start"] + a.holdcap) if d > a.hold else wd["end"]

    keep = []
    seg_start = max(0.0, w[0]["start"] - 0.15)
    prev = eff_end(w[0])
    for i in range(1, len(w)):
        wd = w[i]
        gap = wd["start"] - prev
        if a.maxgap > 0:
            # giữ tối đa maxgap giây im (chia 2 đầu); chỉ cắt khi gap > maxgap
            if gap > a.maxgap:
                end_prev = prev + a.maxgap / 2
                keep.append([round(seg_start, 3), round(end_prev, 3)])
                seg_start = max(end_prev, wd["start"] - a.maxgap / 2)
        elif gap > a.gap:
            keep.append([round(seg_start, 3), round(prev + a.pad, 3)])
            seg_start = max(prev + a.pad, wd["start"] - a.pad)
        prev = eff_end(wd)
    keep.append([round(seg_start, 3), round(prev + 0.15, 3)])
    # bỏ range âm/ngắn
    keep = [r for r in keep if r[1] - r[0] > 0.15]

    # gom các "kill interval" (giây nguồn) từ dedup / restart / cue rồi trừ khỏi keep
    kill = []

    # --dedup: lặp 1 từ liền nhau
    if a.dedup:
        for i in range(len(w) - 1):
            ni, nj = _norm(w[i]["word"]), _norm(w[i+1]["word"])
            if ni and ni == nj and w[i+1]["start"] - w[i]["start"] < 2.0:
                kill.append((w[i]["start"], w[i+1]["start"]))
                print(f"  dedup: '{w[i]['word']}' @ {w[i]['start']:.2f}s → bỏ đến {w[i+1]['start']:.2f}s")

    # tách câu theo khoảng nghỉ > 0.30s (dùng cho restart + cue)
    def clauses_of(words):
        cl, cur, p = [], [], None
        for x in words:
            if p is not None and x["start"] - p > 0.30 and cur:
                cl.append(cur); cur = []
            cur.append(x); p = x["end"]
        if cur: cl.append(cur)
        return cl

    # --restart: take làm lại (2 câu liền nhau mở đầu trùng >= minprefix từ -> bỏ câu trước)
    if a.restart:
        cl = clauses_of(w)
        for i in range(len(cl) - 1):
            an = [_norm(x["word"]) for x in cl[i]]
            bn = [_norm(x["word"]) for x in cl[i+1]]
            p = 0
            while p < len(an) and p < len(bn) and an[p] and an[p] == bn[p]:
                p += 1
            gap = cl[i+1][0]["start"] - cl[i][-1]["end"]
            if p >= a.restart_minprefix and gap < a.restart_maxgap:
                ks, ke = cl[i][0]["start"] - 0.25, cl[i+1][0]["start"]
                kill.append((ks, ke))
                s1 = " ".join(x["word"] for x in cl[i])
                s2 = " ".join(x["word"] for x in cl[i+1])
                print(f"  restart: trùng {p} từ mở đầu @ {ks:.2f}s → bỏ take TRƯỚC, giữ take sau")
                print(f"      bỏ : {s1}")
                print(f"      giữ: {s2}")

    # --cue: tiếng hiệu "làm lại" -> cắt ngược về đầu câu hỏng, bỏ luôn tiếng hiệu
    if a.cue:
        ctoks = [_norm(x) for x in a.cue.split() if _norm(x)]
        nws = [_norm(x["word"]) for x in w]
        cl = clauses_of(w)
        # mốc bắt đầu mỗi câu (giây) để cắt ngược về
        clause_starts = [c[0]["start"] for c in cl]
        i = 0
        while i <= len(nws) - len(ctoks):
            if nws[i:i+len(ctoks)] == ctoks:
                cue_start = w[i]["start"]; cue_end = w[i+len(ctoks)-1]["end"]
                # tìm clause chứa tiếng hiệu rồi lùi về clause TRƯỚC (= câu hỏng)
                cue_cl_idx = next((idx for idx, c in enumerate(cl)
                                   if c[0]["start"] <= cue_start <= c[-1]["end"] + 0.5), None)
                if cue_cl_idx is not None and cue_cl_idx > 0:
                    back = cl[cue_cl_idx - 1][0]["start"] - 0.20
                else:
                    back = cue_start - 0.20
                kill.append((back, cue_end + 0.08))
                print(f"  cue '{a.cue}': bỏ take hỏng {back:.2f}s → {cue_end:.2f}s (gồm cả tiếng hiệu)")
                i += len(ctoks)
            else:
                i += 1

    if kill:
        print(f"kill-intervals: {len(kill)}")
        new_keep = []
        for ks, ke in keep:
            intervals = [(ks, ke)]
            for cs, ce in kill:
                nxt = []
                for a_, b_ in intervals:
                    if ce <= a_ or cs >= b_:
                        nxt.append((a_, b_))
                    else:
                        if cs > a_: nxt.append((a_, cs))
                        if ce < b_: nxt.append((ce, b_))
                intervals = nxt
            new_keep.extend([list(iv) for iv in intervals if iv[1] - iv[0] > 0.10])
        keep = new_keep

    src_dur = w[-1]["end"]
    kept = sum(r[1] - r[0] for r in keep)
    print(f"keep-ranges: {len(keep)} | giữ {kept:.1f}s / nguồn ~{src_dur:.1f}s | sau speed {a.speed}x ≈ {kept/a.speed:.1f}s | cắt bỏ ~{src_dur-kept:.1f}s")
    for r in keep:
        print(f"  {r[0]:.2f} - {r[1]:.2f}  ({r[1]-r[0]:.2f}s)")
    if a.dry:
        return

    if a.remap_out:
        # map t (giây nguồn) -> giây output: cộng dồn các đoạn giữ rồi chia speed
        acc = []
        run = 0.0
        for s, e in keep:
            acc.append(run)
            run += e - s
        def remap(tt):
            for (s, e), off in zip(keep, acc):
                if s - 1e-6 <= tt <= e + 1e-6:
                    return (off + min(max(tt, s), e) - s) / a.speed
            return None  # nằm trong đoạn bị cắt
        def clamp_remap(tt):
            # cho segment bounds: kéo về mép đoạn giữ gần nhất
            best = None
            for (s, e), off in zip(keep, acc):
                if tt < s:
                    cand = off / a.speed
                elif tt > e:
                    cand = (off + e - s) / a.speed
                else:
                    return (off + tt - s) / a.speed
                if best is None or abs(cand * a.speed - tt) < abs(best * a.speed - tt):
                    best = cand
            return best
        out_words = []
        for wd in w:
            os_ = remap(wd["start"])
            if os_ is None:
                continue
            oe = remap(min(wd["end"], wd["start"] + a.holdcap) if wd["end"] - wd["start"] > a.hold else wd["end"])
            if oe is None:
                oe = clamp_remap(wd["end"])
            oe = max(oe, os_ + 0.05)
            out_words.append({"word": wd["word"], "start": round(os_, 3), "end": round(oe, 3)})
        out_segs = []
        for sg in t.get("segments", []):
            ss, se = clamp_remap(sg["start"]), clamp_remap(sg["end"])
            if se - ss < 0.05:
                continue
            out_segs.append({"start": round(ss, 3), "end": round(se, 3), "text": sg.get("text", "")})
        final = {"duration": round(kept / a.speed, 3), "language": t.get("language", "vi"),
                 "text": t.get("text", ""), "words": out_words, "segments": out_segs}
        with open(a.remap_out, "w", encoding="utf-8") as f:
            json.dump(final, f, ensure_ascii=False)
        print(f"remap -> {a.remap_out} ({len(out_words)} words, {len(out_segs)} segments, dur {final['duration']}s)")

    # ffmpeg filter_complex
    parts, vlabs, alabs = [], [], []
    for i, (s, e) in enumerate(keep):
        parts.append(f"[0:v]trim={s}:{e},setpts=PTS-STARTPTS[v{i}];[0:a]atrim={s}:{e},asetpts=PTS-STARTPTS[a{i}]")
        vlabs.append(f"[v{i}]"); alabs.append(f"[a{i}]")
    n = len(keep)
    fc = ";".join(parts)
    fc += f";{''.join(vlabs)}concat=n={n}:v=1:a=0[vc];{''.join(alabs)}concat=n={n}:v=0:a=1[ac]"
    fc += f";[vc]setpts=PTS/{a.speed}[v];[ac]atempo={a.speed}[a]"
    if a.encoder == "nvenc":
        venc = ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0",
                "-maxrate", "14M", "-bufsize", "28M"]
    else:
        venc = ["-c:v", "libx264", "-preset", "medium", "-crf", "19"]
    cmd = ["ffmpeg", "-y", "-i", a.source, "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
           *venc, "-g", "30", "-keyint_min", "30",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", a.out]
    print("running ffmpeg...")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FFMPEG ERROR:\n", r.stderr[-1500:]); sys.exit(1)
    print(f"DONE -> {a.out}")

if __name__ == "__main__":
    main()

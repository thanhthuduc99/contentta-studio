# Contentta Studio — Edit video ngắn (dọc)

App tự host để dựng video short-form (1080×1920): AI cắt vấp, tách cảnh, **phụ đề karaoke 4 style**, kéo-thả b-roll cho từng cảnh, rồi **render bằng ffmpeg thuần** (không cần phần mềm edit). Giao diện web chạy local.

Render một video gồm: mặt người (talking-head) + b-roll overlay + phụ đề burn + nhạc nền.

---

## 1. Yêu cầu cài trước

| Thứ cần | Ghi chú |
|---|---|
| **Node.js 18+** | Chạy server + script. App KHÔNG có package npm ngoài (vanilla). |
| **Python 3.9+** | Cài kèm: `pip install yt-dlp faster-whisper pillow` |
| **ffmpeg** (kèm ffprobe) | Phải có trong PATH. Dùng để cắt + render. |
| Claude Code CLI *(tùy chọn)* | Chỉ cần cho **Mục 1 — viết kịch bản AI**. Không có thì bỏ qua, phần edit vẫn chạy. |

Kiểm nhanh: `node -v`, `python -m yt_dlp --version`, `ffmpeg -version`.

## 2. Cài đặt

```bash
git clone <repo-url> contentta-studio
cd contentta-studio

# điền API key
cp .env.example .env      # rồi mở .env điền key (xem mục 4)

# cài python deps
pip install yt-dlp faster-whisper pillow

# chạy
cd apps/vertical-pro
node server.js
```

Mở trình duyệt: **http://localhost:3100**

## 3. Dùng thế nào

1. Kéo-thả **video quay chính** (ngang 16:9) vào ô upload → app tự transcribe, cắt vấp, tách cảnh.
2. Mỗi cảnh chọn kiểu: **Split** (b-roll trên / mặt dưới), **Full** (b-roll full màn), hoặc **Mặt**.
3. Kéo-thả / tạo **b-roll** cho cảnh Split/Full: upload file, tải từ YouTube/Reddit, lấy stock Pixabay, hoặc tạo bằng AI.
4. Bấm **"Phụ đề"** → **Xem thử trên clip** → chọn 1 trong 4 style (LUKE · HORMOZI 1 · Ali · Umi).
5. Chọn **Nhạc**, bật/tắt **Zoom ảnh**.
6. **Xuất video** → file ở `apps/vertical-pro/projects/<tên>/renders/final.mp4`.

## 4. API key (điền trong `.env`)

| Biến | Bắt buộc? | Lấy ở đâu |
|---|---|---|
| `OPENAI_API_KEY` | Cần cho phụ đề (mặc định) | https://platform.openai.com/api-keys — Whisper transcribe, ~$0.006/phút audio |
| `FAL_KEY` | Tùy chọn — tạo b-roll AI | https://fal.ai/dashboard/keys |
| `PIXABAY_API_KEY` | Tùy chọn — b-roll stock free | https://pixabay.com/api/docs/ |
| `AUTH_USER` + `AUTH_PASSWORD` | Tùy chọn — bật đăng nhập | Để trống = không cần đăng nhập |
| `AUTH_SECRET` | Nên đổi | Chuỗi ngẫu nhiên bất kỳ (ký cookie) |

**Phụ đề miễn phí (không cần OpenAI):** repo có sẵn `contentta-shorts-skill/scripts/transcribe-local.py` chạy **faster-whisper** offline, miễn phí. Hiện pipeline mặc định gọi OpenAI; muốn dùng bản local free thì sửa bước transcribe trong `apps/vertical-pro/scripts/auto-edit.mjs` (đổi `transcribe-openai.mjs` → `python transcribe-local.py`).

## 5. Có sẵn trong repo

- **`apps/vertical-pro/fonts/`** — 4 font phụ đề đủ dấu tiếng Việt (Anton, Be Vietnam Pro, Playfair Display).
- **`apps/vertical-pro/music/`** — 3 track nhạc nền licensed. Thay bằng nhạc của bạn: bỏ file `.mp3` vào đây rồi cập nhật `music.json`.
- **`apps/vertical-pro/background/`** — 2 video nền trắng/đen, dùng khi b-roll full-screen không phủ kín khung.

> ⚠️ **Nhạc bản quyền:** chỉ để nhạc bạn có quyền dùng vào `music/`. Nhạc trong repo này là nhạc licensed; đừng thêm nhạc có bản quyền rồi public.

## 6. Ghi chú kỹ thuật

- `projects/`, `uploads/` (data bạn tạo) **không đẩy lên git** — đã có trong `.gitignore`.
- Render 100% bằng **ffmpeg** trên máy bạn, không gửi video lên đâu cả (trừ bước transcribe gửi audio cho OpenAI nếu dùng bản OpenAI).
- Có RTX/GPU: render nhanh hơn (NVENC tự bật, fallback x264 nếu không có).

---

Made by Contentta.
